import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Log all requests
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

app.use(express.static(join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "public", "index.html"));
});

// Headers for GHL
const getGhlHeaders = (version = "2021-07-28") => ({
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: version,
    "Content-Type": "application/json"
});

/**
 * Endpoint: Get Slots
 */
app.get("/api/slots", async (req, res) => {
    console.log("\n🔍 SLOT FETCH REQUEST");
    const calendarId = process.env.GHL_CALENDAR_ID;

    // Window: Now to 14 days
    const now = new Date();
    const future = new Date(now.getTime() + (14 * 24 * 60 * 60 * 1000));

    const url = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${future.getTime()}`;

    try {
        const response = await fetch(url, { headers: getGhlHeaders() });
        const data = await response.json();

        if (!response.ok) {
            console.error("❌ GHL Error (Slots):", data);
            return res.status(response.status).json(data);
        }

        // Flatten slots
        let allSlots = [];
        Object.keys(data).forEach(day => {
            if (data[day] && Array.isArray(data[day].slots)) {
                data[day].slots.forEach(s => allSlots.push(s));
            }
        });

        console.log(`✅ Found ${allSlots.length} slots.`);
        res.json({ slots: allSlots.slice(0, 20) }); // Send first 20
    } catch (err) {
        console.error("❌ Server Error (Slots):", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Endpoint: Book Appointment
 */
app.post("/api/book", async (req, res) => {
    console.log("\n📅 BOOKING REQUEST RECEIVED");
    console.log("Body:", JSON.stringify(req.body, null, 2));

    const { firstName, email, slot } = req.body;

    if (!firstName || !email || !slot) {
        return res.status(400).json({ error: "Missing firstName, email, or slot" });
    }

    try {
        // 1. Search for existing contact or create
        console.log(`👤 Identifying contact: ${email}`);
        const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
        const searchRes = await fetch(searchUrl, { headers: getGhlHeaders() });
        const searchData = await searchRes.json();

        let contactId = searchData?.contact?.id;

        if (contactId) {
            console.log("   Found existing contact. Updating info...");
            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                method: "PUT",
                headers: getGhlHeaders(),
                body: JSON.stringify({
                    firstName,
                    email,
                    locationId: process.env.GHL_LOCATION_ID,
                    tags: ["GHL-App-Test", "Voice-AI-Lead"]
                })
            });
        } else {
            console.log("   Creating new contact...");
            const createRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
                method: "POST",
                headers: getGhlHeaders(),
                body: JSON.stringify({
                    firstName,
                    email,
                    locationId: process.env.GHL_LOCATION_ID,
                    tags: ["GHL-App-Test", "Voice-AI-New-Lead"]
                })
            });
            const createData = await createRes.json();
            contactId = createData?.contact?.id;
        }

        if (!contactId) throw new Error("Could not create/find contact");

        // 2. Book the appointment
        const startTime = new Date(slot).toISOString();
        const endTime = new Date(new Date(slot).getTime() + 30 * 60000).toISOString();

        const bookingBody = {
            calendarId: process.env.GHL_CALENDAR_ID,
            locationId: process.env.GHL_LOCATION_ID,
            contactId: contactId,
            startTime,
            endTime,
            title: `App Booking: ${firstName}`,
            appointmentStatus: "confirmed",
            assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
            ignoreFreeSlotValidation: true
        };

        console.log("📡 Sending booking to GHL...");
        const bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
            method: "POST",
            headers: getGhlHeaders("2021-04-15"),
            body: JSON.stringify(bookingBody)
        });

        const bookData = await bookRes.json();

        if (bookRes.ok) {
            console.log("🚀 SUCCESS!");
            res.json({ success: true, data: bookData });
        } else {
            console.error("❌ GHL Rejected Booking:", bookData);
            res.status(400).json({ success: false, error: bookData.message || "GHL rejection" });
        }

    } catch (err) {
        console.error("❌ Server Error (Booking):", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * AI TOOL BRIDGE: Retell AI calls these
 */
app.post("/retell/check_availability", async (req, res) => {
    console.log("\n🤖 AI SEARCHING SLOTS...");
    const calendarId = process.env.GHL_CALENDAR_ID;
    const now = new Date();
    const future = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000)); // AI only looks 7 days ahead

    const url = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${future.getTime()}`;

    try {
        const response = await fetch(url, { headers: getGhlHeaders() });
        const data = await response.json();

        let allSlots = [];
        Object.keys(data).forEach(day => {
            if (data[day]?.slots) allSlots.push(...data[day].slots);
        });

        console.log(`🤖 AI found ${allSlots.length} options.`);
        res.json({ available_slots: allSlots.slice(0, 5) }); // Give AI 5 clean options
    } catch (err) {
        res.status(500).json({ error: "GHL sync failed" });
    }
});

app.post("/retell/book_appointment", async (req, res) => {
    console.log("\n🤖 AI BOOKING ATTEMPT...");
    // AI sends args inside a body
    const { args } = req.body;
    const firstName = args.first_name || args.firstName;
    const email = args.email;
    const phone = args.phone;
    const slot = args.date_time || args.dateTime;

    try {
        // Find/Upsert Contact
        const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
        const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
        const sData = await sRes.json();
        let contactId = sData?.contact?.id;

        if (contactId) {
            console.log("   Updating existing contact with phone...");
            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                method: "PUT",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
        } else {
            console.log("   Creating new contact with phone...");
            const cRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
                method: "POST",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
            const cData = await cRes.json();
            contactId = cData?.contact?.id;
        }

        // Finalize Booking
        const bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
            method: "POST",
            headers: getGhlHeaders("2021-04-15"),
            body: JSON.stringify({
                calendarId: process.env.GHL_CALENDAR_ID,
                locationId: process.env.GHL_LOCATION_ID,
                contactId,
                startTime: new Date(slot).toISOString(),
                endTime: new Date(new Date(slot).getTime() + 30 * 60000).toISOString(),
                title: `Voice AI Booking: ${firstName}`,
                appointmentStatus: "confirmed",
                assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
                ignoreFreeSlotValidation: true
            })
        });

        const bData = await bookRes.json();
        if (bookRes.ok) {
            console.log("🤖 AI BOOKING SUCCESS!");
            res.json({ status: "success", message: "Appointment confirmed!" });
        } else {
            console.error("🤖 GHL REJECTED AI:", bData);
            res.status(400).json({ error: bData.message });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 GHL Scheduler Debug App running at http://localhost:${PORT}`);
    console.log(`📁 Serving files from: ${join(__dirname, "public")}`);
});
