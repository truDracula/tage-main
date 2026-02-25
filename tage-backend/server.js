const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function giveCommission(userId, amount) {
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

app.post('/register', async (req, res) => {
    const { telegram_id, username, referrer_id } = req.body;
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

        if (updateError) return res.status(500).json(updateError);
        return res.json(updatedUser);
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

    if (error) return res.status(500).json(error);
    res.json(newUser);
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
    const { telegram_id, task_id } = req.body;

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
            points: user.points + 1000,
            completed_tasks: [...tasks, task_id]
        })
        .eq('telegram_id', telegram_id);

    if (updateError) return res.status(500).json(updateError);

    await giveCommission(telegram_id, 1000);
    res.json({ success: true, message: "Points added and task recorded!" });
});

app.post('/watch-ad', async (req, res) => {
    const { telegram_id } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('*')
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

    const newPoints = user.points + 500;
    const watchedToday = count + 1;
    const { error } = await supabase
        .from('users')
        .update({
            points: newPoints,
            ads_watched_today: watchedToday,
            last_ad_date: today
        })
        .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json(error);

    await giveCommission(telegram_id, 500);
    res.json({ success: true, newPoints, watchedToday });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
