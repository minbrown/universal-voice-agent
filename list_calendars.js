import fetch from "node-fetch";
import "dotenv/config";

const GHL_HEADERS = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json"
};

async function listCalendars() {
    console.log("🔍 Fetching Calendars for Location:", process.env.GHL_LOCATION_ID);
    const url = `https://services.leadconnectorhq.com/calendars/?locationId=${process.env.GHL_LOCATION_ID}`;
    
    try {
        const res = await fetch(url, { headers: GHL_HEADERS });
        const data = await res.json();
        
        if (!res.ok) {
            console.error("❌ Error fetching calendars:", data);
            return;
        }

        console.log("\n✅ AVAILABLE CALENDARS:");
        data.calendars.forEach(cal => {
            console.log(`- NAME: ${cal.name}`);
            console.log(`  ID:   ${cal.id}`);
            console.log(`  TYPE: ${cal.calendarType}`);
            console.log("-------------------");
        });
    } catch (err) {
        console.error("❌ Connection error:", err.message);
    }
}

listCalendars();
