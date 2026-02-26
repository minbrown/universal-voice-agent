import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const headers = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: '2021-04-15',
    'Content-Type': 'application/json'
};

async function main() {
    // 1. First find the contact
    const h2 = { ...headers, Version: '2021-07-28' };
    const dupRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&number=${encodeURIComponent('+17708755882')}`, { headers: h2 });
    const dupData = await dupRes.json();
    console.log("Contact lookup:", dupData?.contact ? `${dupData.contact.firstName} (${dupData.contact.id})` : "NOT FOUND");

    if (!dupData?.contact) {
        console.log("Cannot test booking without contact. Exiting.");
        return;
    }

    const contactId = dupData.contact.id;

    // 2. Test booking directly
    const slot = "2026-02-27T10:00:00-05:00";
    const bookBody = {
        calendarId: process.env.GHL_CALENDAR_ID,
        locationId: process.env.GHL_LOCATION_ID,
        contactId,
        startTime: new Date(slot).toISOString(),
        endTime: new Date(new Date(slot).getTime() + 30 * 60000).toISOString(),
        title: "Test Direct Booking",
        appointmentStatus: "confirmed",
        assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
        ignoreFreeSlotValidation: true
    };

    console.log("\nBooking request:", JSON.stringify(bookBody, null, 2));

    const bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
        method: "POST",
        headers,
        body: JSON.stringify(bookBody)
    });

    const bookData = await bookRes.json();
    console.log("\nBooking response status:", bookRes.status);
    console.log("Booking response:", JSON.stringify(bookData, null, 2));

    // 3. If success, immediately cancel it
    if (bookRes.ok && bookData?.id) {
        console.log("\n✅ Booking succeeded! Cleaning up (cancelling test appointment)...");
        const cancelRes = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${bookData.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ calendarId: process.env.GHL_CALENDAR_ID, locationId: process.env.GHL_LOCATION_ID, appointmentStatus: "cancelled" })
        });
        console.log("Cancel status:", cancelRes.status);
    }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
