const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: '*'
    ,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    const { initData, telegram_id, task_reward } = req.body;
    const reward = Number(task_reward) || 0;

    if (!verifyTelegramData(initData)) {
        return res.status(403).json({ error: "Invalid signature. Stop hacking!" });
    }
    if (reward <= 0) {
        return res.status(400).json({ error: "Invalid task reward" });
    }

    await awardPoints(telegram_id, reward);
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
    await awardPoints(telegram_id, 500);

    const { error } = await supabase
        .from('users')
        .update({
            ads_watched_today: watchedToday,
            last_ad_date: today
        })
        .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json(error);

    res.json({ success: true, newPoints: user.points + 500, watchedToday });
});

app.get('/leaderboard', async (req, res) => {
    const type = req.query.type || 'total';

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

app.post('/admin/execute', async (req, res) => {
    const { auth_key, admin_id, action, payload } = req.body;
    if (auth_key !== process.env.ADMIN_SECRET_KEY || parseInt(admin_id) !== 1755569721) {
        return res.status(403).send("Unauthorized");
    }

    switch (action) {
        case 'add_task':
            await supabase.from('tasks').insert([payload]);
            return res.json({ success: true });

        case 'ban_user':
            await supabase.from('users').update({ status: 'banned' }).eq('telegram_id', payload.uid);
            return res.json({ success: true });

        case 'unban_user':
            await supabase.from('users').update({ status: 'active' }).eq('telegram_id', payload.uid);
            return res.json({ success: true });

        case 'get_detailed_users': {
            const { data } = await supabase.from('users').select('*');
            return res.json(data);
        }

        case 'get_users': {
            const { data } = await supabase.from('users').select('*').order('points', { ascending: false });
            return res.json(data);
        }

        default:
            return res.status(400).send("Unknown action");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
