import fetch from "node-fetch";
import "dotenv/config";

const GHL_HEADERS = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json"
};

async function testBooking() {
    const calendarId = process.env.GHL_CALENDAR_ID;
    const locationId = process.env.GHL_LOCATION_ID;
    const assignedUserId = process.env.GHL_ASSIGNED_USER_ID;

    // 1. Create/Identify a Test Contact
    console.log("👤 Step 1: Ensuring Test Contact exists...");
    const contactData = {
        firstName: "Test",
        lastName: "Booking",
        email: "test_booking_" + Date.now() + "@example.com",
        phone: "+15550009999",
        locationId: locationId
    };

    const contactRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
        method: "POST",
        headers: GHL_HEADERS,
        body: JSON.stringify(contactData)
    });
    const contactResult = await contactRes.json();

    if (!contactRes.ok) {
        console.error("❌ Failed to create contact:", contactResult);
        return;
    }

    const contactId = contactResult.contact.id;
    console.log(`✅ Contact Ready: ${contactId}`);

    // 2. Select a slot (Hardcoded for testing based on availability output)
    // We'll pick a slot 2 days from now to be safe
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 2);
    targetDate.setHours(10, 0, 0, 0); // 10:00 AM

    const startTime = targetDate.toISOString();
    const endTime = new Date(targetDate.getTime() + 30 * 60000).toISOString();

    console.log(`\n📅 Step 2: Attempting Booking for ${startTime}...`);

    const bookingBody = {
        calendarId: calendarId,
        locationId: locationId,
        contactId: contactId,
        startTime: startTime,
        endTime: endTime,
        title: "Retell AI Test Booking",
        appointmentStatus: "confirmed",
        assignedUserId: assignedUserId,
        ignoreFreeSlotValidation: true // Useful for debugging/forcing
    };

    console.log("📡 Sending Booking Request...");

    // IMPORTANT: Appointments often require Version 2021-04-15
    const bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
        method: "POST",
        headers: {
            ...GHL_HEADERS,
            Version: "2021-04-15"
        },
        body: JSON.stringify(bookingBody)
    });

    const bookResult = await bookRes.json();

    if (bookRes.ok) {
        console.log("🚀 SUCCESS! Appointment Booked!");
        console.log(JSON.stringify(bookResult, null, 2));
    } else {
        console.error("❌ BOOKING FAILED!");
        console.error(`Status: ${bookRes.status}`);
        console.error("GHL Error Message:", JSON.stringify(bookResult, null, 2));

        if (bookResult.message && bookResult.message.includes("Version")) {
            console.log("💡 Hint: There might be a Version header mismatch.");
        }
    }
}

testBooking();
