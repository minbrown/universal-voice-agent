import fetch from "node-fetch";
import "dotenv/config";

const GHL_HEADERS = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-04-15",
    "Content-Type": "application/json"
};

async function checkRecentAppointments() {
    const calendarId = process.env.GHL_CALENDAR_ID;
    const locationId = process.env.GHL_LOCATION_ID;

    // Window: Start of today to +30 days
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setDate(end.getDate() + 30);

    console.log(`🔍 Searching Appointments from ${start.toISOString()} to ${end.toISOString()}`);

    // GHL v2 List Events Path: /calendars/events
    // Note: The previous attempt failed because it requires startTime and endTime query params in ms
    const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${start.getTime()}&endTime=${end.getTime()}`;

    try {
        const res = await fetch(url, { headers: GHL_HEADERS });
        const data = await res.json();

        if (!res.ok) {
            console.error("❌ GHL Error:", JSON.stringify(data, null, 2));
            return;
        }

        console.log("\n📅 APPOINTMENTS FOUND:");
        if (data.events && data.events.length > 0) {
            data.events.forEach(e => {
                console.log(`- [${e.appointmentStatus}] ${e.title}`);
                console.log(`  Start:  ${e.startTime}`);
                console.log(`  Contact ID: ${e.contactId}`);
                console.log("-------------------");
            });
        } else {
            console.log("No appointments found in this range.");
        }
    } catch (err) {
        console.error("❌ Connection error:", err.message);
    }
}

checkRecentAppointments();
