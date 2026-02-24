import fetch from "node-fetch";
import "dotenv/config";

const GHL_HEADERS = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json"
};

async function testAvailability() {
    const calendarId = process.env.GHL_CALENDAR_ID;

    // Calculate range: Today to +7 days
    const now = new Date();
    const future = new Date();
    future.setDate(now.getDate() + 7);

    console.log(`🔍 Testing Availability for Calendar: ${calendarId}`);
    console.log(`📅 Range: ${now.toISOString()} to ${future.toISOString()}`);

    // GHL v2 Path: /calendars/{calendarId}/free-slots
    // Uses Unix Timestamps in milliseconds
    const url = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${future.getTime()}`;

    try {
        const res = await fetch(url, { headers: GHL_HEADERS });
        const data = await res.json();

        if (!res.ok) {
            console.error("❌ GHL API REJECTED REQUEST:");
            console.error(JSON.stringify(data, null, 2));
            return;
        }

        console.log("✅ GHL API SUCCESS!");

        // GHL returns an object where keys are dates (YYYY-MM-DD)
        const days = Object.keys(data);
        console.log(`📅 Found availability for ${days.length} days.`);

        if (days.length > 0) {
            days.slice(0, 3).forEach(day => {
                const slots = data[day].slots || [];
                console.log(`   - ${day}: ${slots.length} slots available.`);
                if (slots.length > 0) {
                    console.log(`     Example Slot: ${slots[0]}`);
                }
            });
        } else {
            console.warn("⚠️ No slots found. This usually means:");
            console.warn("1. The calendar has no working hours set.");
            console.warn("2. The assigned user has no availability.");
            console.warn("3. The calendar is fully booked.");
        }

    } catch (err) {
        console.error("❌ Connection error:", err.message);
    }
}

testAvailability();
