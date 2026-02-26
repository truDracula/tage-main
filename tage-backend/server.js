const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let bot = null;

try {
    const TelegramBot = require('node-telegram-bot-api');
    if (process.env.TELEGRAM_BOT_TOKEN) {
        bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            const welcomeText = `
*Welcome to Tage App!*

*Earnings:* Watch ads and complete tasks to earn points.
*Referrals:* Earn 20% commission from your friends!
*Leagues:* Climb from Newbie to Titan.

Click the button below to launch the app!
            `;

            bot.sendMessage(chatId, welcomeText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Launch App", web_app: { url: "https://tage-main.vercel.app" } }
                    ]]
                }
            });
        });
    }
} catch (e) {
    // Bot is optional in this backend process.
}

function verifyTelegramData(initData) {
    if (!initData || !process.env.TELEGRAM_BOT_TOKEN) return false;

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(process.env.TELEGRAM_BOT_TOKEN)
        .digest();

    const signature = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    return signature === hash;
}

async function awardPoints(userId, amount) {
    await supabase.rpc('increment_points', { user_id: userId, amount });

    const { data: user } = await supabase
        .from('users')
        .select('referred_by')
        .eq('telegram_id', userId)
        .single();

    if (user && user.referred_by) {
        const commission = Math.floor(amount * 0.20);
        if (commission > 0) {
            await supabase.rpc('increment_points', {
                user_id: user.referred_by,
                amount: commission
            });
        }
    }
}

async function upsertUser(telegram_id, username, referrer_id) {
    const referredBy =
        referrer_id && String(referrer_id) !== String(telegram_id) ? referrer_id : null;

    const { data: existingUser } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegram_id)
        .single();

    if (existingUser) {
        const updatePayload = { username };
        if (!existingUser.referred_by && referredBy) {
            updatePayload.referred_by = referredBy;
        }

        const { data: updatedUser, error: updateError } = await supabase
            .from('users')
            .update(updatePayload)
            .eq('telegram_id', telegram_id)
            .select()
            .single();

        if (updateError) throw updateError;
        return { user: updatedUser, isNewUser: false };
    }

    const { data: newUser, error } = await supabase
        .from('users')
        .insert({
            telegram_id,
            username,
            referred_by: referredBy,
            points: 0,
            account_age_days: 0,
            completed_tasks: [],
            ads_watched_today: 0,
            last_ad_date: null
        })
        .select()
        .single();

    if (error) throw error;
    return { user: newUser, isNewUser: true };
}

app.post('/register', async (req, res) => {
    const { telegram_id, username, referrer_id } = req.body;
    try {
        const { user } = await upsertUser(telegram_id, username, referrer_id);
        res.json(user);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/check-user', async (req, res) => {
    const { telegram_id, username, referrer_id } = req.body;

    try {
        const result = await upsertUser(telegram_id, username, referrer_id);
        const { count } = await supabase
            .from('users')
            .select('*', { head: true, count: 'exact' })
            .eq('referred_by', telegram_id);

        res.json({ isNewUser: result.isNewUser, user: result.user, ref_count: count || 0 });
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/user-init', async (req, res) => {
    const { uid, username, referrer_id } = req.body;

    try {
        const result = await upsertUser(uid, username || 'Guest', referrer_id || null);
        res.json({
            ...result.user,
            isNewUser: result.isNewUser,
            status: result.user.status || 'active'
        });
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/auth', async (req, res) => {
    const { userId, username } = req.body;
    
    // Check if user exists
    let { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', userId)
        .single();

    if (!user) {
        // Create new user if not found
        const age = Math.floor(Math.random() * 2000) + 100; // Mock age
        const { data: newUser } = await supabase
            .from('users')
            .insert([{ 
                telegram_id: userId, 
                username: username, 
                points: age * 10,
                account_age_days: age,
                completed_tasks: [],
                ads_watched_today: 0,
                last_ad_date: null
            }])
            .select().single();
        user = newUser;
    }
    res.json(user);
});

app.post('/complete-task', async (req, res) => {
    const { initData, telegram_id, task_id } = req.body;

    if (!verifyTelegramData(initData)) {
        return res.status(403).json({ error: "Invalid signature. Stop hacking!" });
    }

    const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('points, completed_tasks')
        .eq('telegram_id', telegram_id)
        .single();

    if (fetchError || !user) return res.status(404).json({ error: "User not found" });

    const tasks = user.completed_tasks || [];
    if (tasks.includes(task_id)) {
        return res.status(400).json({ error: "Task already claimed!" });
    }

    const { error: updateError } = await supabase
        .from('users')
        .update({
            completed_tasks: [...tasks, task_id]
        })
        .eq('telegram_id', telegram_id);

    if (updateError) return res.status(500).json(updateError);

    await awardPoints(telegram_id, 1000);
    res.json({ success: true, message: "Points added and task recorded!" });
});

app.post('/claim-task', async (req, res) => {
    const { initData, userId, uid, taskId, telegram_id, task_reward } = req.body;
    const userUid = uid || userId || telegram_id;
    const taskReward = Number(task_reward) || 0;
    const nowIso = new Date().toISOString();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    if (initData && !verifyTelegramData(initData)) {
        return res.status(403).json({ error: "Invalid signature. Stop hacking!" });
    }
    if (!userUid) {
        return res.status(400).json({ error: "Missing user id" });
    }

    const { data: existing, error: existingError } = await supabase
        .from('task_completions')
        .select('*')
        .eq('user_id', userUid)
        .eq('task_id', taskId)
        .gt('completed_at', twentyFourHoursAgo);

    if (existingError) return res.status(500).json({ error: existingError.message });
    if ((existing || []).length > 0) {
        return res.json({ success: false, message: "Already claimed today!" });
    }

    const { error: insertError } = await supabase
        .from('task_completions')
        .insert([{
            user_id: userUid,
            task_id: taskId,
            completed_at: nowIso
        }]);
    if (insertError) return res.status(500).json({ error: insertError.message });

    let reward = taskReward;
    if ((!reward || reward <= 0) && taskId) {
        const { data: taskData } = await supabase
            .from('tasks')
            .select('points')
            .eq('id', taskId)
            .single();
        reward = Number(taskData?.points || 0);
    }
    if (reward <= 0) {
        return res.status(400).json({ error: "Invalid task reward" });
    }

    await awardPoints(userUid, reward);
    res.json({ success: true });
});

app.post('/watch-ad', async (req, res) => {
    const { initData, telegram_id } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (!verifyTelegramData(initData)) {
        return res.status(403).json({ error: "Invalid signature. Stop hacking!" });
    }

    const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('points, ads_watched_today, last_ad_date')
        .eq('telegram_id', telegram_id)
        .single();

    if (fetchError || !user) return res.status(404).json({ error: "User not found" });

    let count = user.ads_watched_today || 0;
    if (user.last_ad_date !== today) {
        count = 0;
    }

    if (count >= 10) {
        return res.status(400).json({ error: "Daily limit reached" });
    }

    const watchedToday = count + 1;
    await awardPoints(telegram_id, 1000);

    const { error } = await supabase
        .from('users')
        .update({
            ads_watched_today: watchedToday,
            last_ad_date: today
        })
        .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json(error);

    res.json({ success: true, newPoints: user.points + 1000, watchedToday });
});

app.post('/add-ad-reward', async (req, res) => {
    const { initData, uid, amount } = req.body;
    const telegram_id = Number(uid);
    const rewardAmount = Number(amount || 1000);
    const today = new Date().toISOString().split('T')[0];

    if (!telegram_id || rewardAmount <= 0) {
        return res.status(400).json({ error: "Invalid payload" });
    }
    if (!verifyTelegramData(initData)) {
        return res.status(403).json({ error: "Invalid signature. Stop hacking!" });
    }

    const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('points, ads_watched_today, last_ad_date')
        .eq('telegram_id', telegram_id)
        .single();

    if (fetchError || !user) return res.status(404).json({ error: "User not found" });

    let count = user.ads_watched_today || 0;
    if (user.last_ad_date !== today) count = 0;
    if (count >= 10) return res.status(400).json({ error: "Daily limit reached" });

    const watchedToday = count + 1;
    await awardPoints(telegram_id, rewardAmount);

    const { error } = await supabase
        .from('users')
        .update({
            ads_watched_today: watchedToday,
            last_ad_date: today
        })
        .eq('telegram_id', telegram_id);
    if (error) return res.status(500).json(error);

    res.json({ success: true, newPoints: user.points + rewardAmount, watchedToday });
});

app.get('/leaderboard', async (req, res) => {
    const type = req.query.sort || req.query.type || 'total';

    if (type === 'refs') {
        const { data: users, error } = await supabase
            .from('users')
            .select('telegram_id, username, referred_by');
        if (error) return res.status(500).json(error);

        const counts = {};
        for (const u of users || []) {
            if (u.referred_by) counts[u.referred_by] = (counts[u.referred_by] || 0) + 1;
        }

        const ranking = (users || [])
            .map((u) => ({
                username: u.username,
                ref_count: counts[u.telegram_id] || 0
            }))
            .sort((a, b) => b.ref_count - a.ref_count)
            .slice(0, 50);

        return res.json(ranking);
    }

    const { data: topUsers, error } = await supabase
        .from('users')
        .select('username, points')
        .order('points', { ascending: false })
        .limit(50);

    if (error) return res.status(500).json(error);
    res.json(topUsers || []);
});

app.get('/get-tasks', async (req, res) => {
    const { uid } = req.query;

    const { data: allTasks, error } = await supabase
        .from('tasks')
        .select('*')
        .order('id', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    if (!uid) return res.json(allTasks || []);

    const { data: completedRows, error: completedError } = await supabase
        .from('completed_tasks')
        .select('task_id')
        .eq('user_id', uid);
    if (completedError) return res.status(500).json({ error: completedError.message });

    const completedIds = new Set((completedRows || []).map((row) => Number(row.task_id)));
    const filtered = (allTasks || []).filter((task) => !completedIds.has(Number(task.id)));
    res.json(filtered);
});

app.get('/get-available-tasks', async (req, res) => {
    const { userId } = req.query;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: allTasks, error: tasksError } = await supabase.from('tasks').select('*');
    if (tasksError) return res.status(500).json({ error: tasksError.message });

    if (!userId) {
        return res.json((allTasks || []).map((task) => ({ ...task, isClaimed: false })));
    }

    const { data: recentCompletions, error: completionsError } = await supabase
        .from('task_completions')
        .select('task_id')
        .eq('user_id', userId)
        .gt('completed_at', twentyFourHoursAgo);
    if (completionsError) return res.status(500).json({ error: completionsError.message });

    const completedIds = new Set((recentCompletions || []).map((c) => c.task_id));
    const tasksWithStatus = (allTasks || []).map((task) => ({
        ...task,
        isClaimed: completedIds.has(task.id)
    }));

    res.json(tasksWithStatus);
});

app.post('/admin/execute', async (req, res) => {
    const { auth_key, admin_id, action, payload } = req.body;

    if (auth_key !== process.env.ADMIN_SECRET_KEY || parseInt(admin_id) !== 1755569721) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    try {
        switch (action) {
            case 'add_task': {
                const { title, link, points, category } = payload;
                const { data: taskData, error: taskError } = await supabase
                    .from('tasks')
                    .insert([{
                        title,
                        link,
                        points: parseInt(points),
                        category: category || 'partner'
                    }]);
                if (taskError) return res.status(500).json({ success: false, error: taskError.message });
                return res.json({ success: true, message: "Task Published!", data: taskData });
            }

            case 'get_users': {
                const { data: users, error: userError } = await supabase
                    .from('users')
                    .select('*')
                    .order('points', { ascending: false });
                if (userError) throw userError;
                return res.json({ success: true, data: users });
            }

            case 'get_detailed_users': {
                const { data, error } = await supabase.from('users').select('*');
                if (error) throw error;
                return res.json({ success: true, data });
            }

            case 'ban_user':
                await supabase.from('users').update({ is_banned: true, status: 'banned' }).eq('telegram_id', payload.uid);
                return res.json({ success: true });

            case 'unban_user':
                await supabase.from('users').update({ is_banned: false, status: 'active' }).eq('telegram_id', payload.uid);
                return res.json({ success: true });

            case 'claim_milestone': {
                const { uid, milestone_key } = payload;

                const { data: milestoneUser, error: milestoneUserError } = await supabase
                    .from('users')
                    .select('referral_count')
                    .eq('telegram_id', uid)
                    .single();
                if (milestoneUserError) throw milestoneUserError;

                const requirements = { ref_5: 5, ref_25: 25, ref_100: 100 };
                const rewards = { ref_5: 10000, ref_25: 100000, ref_100: 1000000 };
                const needed = requirements[milestone_key];
                if (!needed) return res.status(400).json({ success: false, error: "Invalid milestone key" });

                if (Number(milestoneUser?.referral_count || 0) < needed) {
                    return res.status(400).json({ success: false, error: "Milestone not reached yet!" });
                }

                const { data: existingClaim } = await supabase
                    .from('milestones')
                    .select('id')
                    .eq('telegram_id', uid)
                    .eq('milestone_key', milestone_key)
                    .single();
                if (existingClaim) {
                    return res.status(400).json({ success: false, error: "Milestone already claimed" });
                }

                const { error: claimInsertError } = await supabase.from('milestones').insert([{
                    telegram_id: uid,
                    milestone_key,
                    claimed_at: new Date().toISOString()
                }]);
                if (claimInsertError) throw claimInsertError;

                await awardPoints(uid, rewards[milestone_key]);
                return res.json({ success: true });
            }

            case 'broadcast': {
                const message = payload?.message;
                if (!message) return res.status(400).json({ error: "Missing message" });
                if (!process.env.TELEGRAM_BOT_TOKEN) {
                    return res.status(500).json({ error: "Missing TELEGRAM_BOT_TOKEN" });
                }

                const { data: users, error } = await supabase.from('users').select('telegram_id');
                if (error) throw error;

                let successCount = 0;
                for (const u of users || []) {
                    if (!u.telegram_id) continue;
                    try {
                        const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: u.telegram_id,
                                text: message
                            })
                        });
                        if (r.ok) successCount++;
                    } catch (_) {}
                }

                return res.json({ success: true, successCount });
            }

            default:
                return res.status(400).json({ error: "Invalid Action" });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
