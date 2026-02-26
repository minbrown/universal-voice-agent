import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const headers = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json'
};

const locationId = process.env.GHL_LOCATION_ID;
const calendarId = process.env.GHL_CALENDAR_ID;

async function main() {
    // 1. Get recent contacts
    console.log("=== RECENT CONTACTS ===");
    const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=5`, { headers });
    const cData = await cRes.json();
    for (const c of (cData.contacts || [])) {
        console.log(`  ${c.id} | ${c.firstName} ${c.lastName || ''} | ${c.phone} | ${c.email}`);

        // Get their appointments
        const aRes = await fetch(`https://services.leadconnectorhq.com/contacts/${c.id}/appointments`, { headers });
        const aData = await aRes.json();
        const appts = aData?.appointments || [];
        if (appts.length > 0) {
            for (const a of appts) {
                console.log(`    📅 ${a.id} | ${a.startTime} | status: ${a.appointmentStatus} | calendarId: ${a.calendarId}`);
            }
        } else {
            console.log("    (no appointments)");
        }
    }

    // 2. Check calendar events directly
    console.log("\n=== FUTURE CALENDAR EVENTS ===");
    const now = Date.now();
    const future = now + 7 * 24 * 60 * 60 * 1000;
    const eRes = await fetch(`https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${now}&endTime=${future}`, { headers });
    const eData = await eRes.json();
    for (const e of (eData?.events || [])) {
        console.log(`  ${e.id} | ${e.startTime} | status: ${e.appointmentStatus} | contact: ${e.contactId} | title: ${e.title}`);
    }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
