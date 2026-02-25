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

const debugLogs = [];
const addDebugLog = (msg) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    debugLogs.unshift(entry);
    if (debugLogs.length > 50) debugLogs.pop();
};

// Log all requests
app.use((req, res, next) => {
    addDebugLog(`${req.method} ${req.url}`);
    next();
});

const normalizePhone = (phone) => {
    if (!phone) return null;
    return phone.replace(/\D/g, '').slice(-10); // Last 10 digits
};

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
    const { args } = req.body;
    const phone = args?.phone;
    const email = args?.email;

    const calendarId = process.env.GHL_CALENDAR_ID;
    const now = new Date();
    const future = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000)); // Search 30 days ahead

    addDebugLog(`Availability requested for Phone: ${phone}, Email: ${email}`);

    try {
        // 1. Fetch free slots (7-day window for AI to suggest)
        const sevenDays = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        const slotsUrl = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${sevenDays.getTime()}`;
        const slotsRes = await fetch(slotsUrl, { headers: getGhlHeaders() });
        const slotsData = await slotsRes.json();

        let availableSlots = [];
        Object.keys(slotsData).forEach(day => {
            if (slotsData[day]?.slots) availableSlots.push(...slotsData[day].slots);
        });

        // 2. Identify all caller appointments
        let existingAppointments = [];

        if (phone || email) {
            const searchVal = phone ? normalizePhone(phone) : email;
            const searchKey = phone ? "number" : "email";
            const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&${searchKey}=${encodeURIComponent(searchVal)}`;
            const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
            const sData = await sRes.json();
            const contactId = sData?.contact?.id;

            addDebugLog(`Contact lookup for ${searchKey} ${searchVal}: ${contactId || "NOT FOUND"}`);

            if (contactId) {
                // Search up to 30 days for existing
                const apptUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${now.getTime()}&endTime=${future.getTime()}`;
                const aRes = await fetch(apptUrl, { headers: getGhlHeaders() });
                const aData = await aRes.json();

                existingAppointments = (aData?.events || [])
                    .filter(e => e.contactId === contactId && (e.status === 'booked' || e.status === 'confirmed' || e.status === 'new'))
                    .map(e => ({
                        appointment_id: e.id,
                        time: e.startTime,
                        title: e.title
                    }));
            }
        }

        console.log(`🤖 AI found ${availableSlots.length} options and ${existingAppointments.length} existing bookings.`);

        res.json({
            available_slots: availableSlots.slice(0, 5),
            existing_appointments: existingAppointments
        });
    } catch (err) {
        console.error("❌ Availability Error:", err.message);
        res.status(500).json({ error: "GHL sync failed" });
    }
});

app.post("/retell/book_appointment", async (req, res) => {
    console.log("\n🤖 AI BOOKING ATTEMPT...");
    const { args } = req.body;
    const firstName = args.first_name || args.firstName || "Unknown";
    const email = args.email;
    const phone = args.phone;
    const slot = args.date_time || args.dateTime;
    const appointmentId = args.appointment_id; // Targeted reschedule

    if (!slot) {
        return res.status(400).json({ error: "Missing slot/date_time" });
    }

    try {
        let contactId = null;

        // Search by Phone
        if (phone) {
            const pRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&number=${encodeURIComponent(phone)}`, { headers: getGhlHeaders() });
            const pData = await pRes.json();
            contactId = pData?.contact?.id;
        }

        // Fallback Email
        if (!contactId && email) {
            const eRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`, { headers: getGhlHeaders() });
            const eData = await eRes.json();
            contactId = eData?.contact?.id;
        }

        // Upsert Contact
        if (contactId) {
            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                method: "PUT",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
        } else {
            const cRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
                method: "POST",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
            const cData = await cRes.json();
            contactId = cData?.contact?.id;
        }

        if (!contactId) throw new Error("Failed to resolve contact ID");

        const startTime = new Date(slot).toISOString();
        const endTime = new Date(new Date(slot).getTime() + 30 * 60000).toISOString();

        let bookRes;
        if (appointmentId) {
            console.log(`🔄 Targeted reschedule for ID: ${appointmentId}`);
            const updateUrl = `https://services.leadconnectorhq.com/calendars/events/appointments/${appointmentId}`;
            const body = {
                startTime,
                endTime,
                title: `Voice AI Update: ${firstName}`,
                calendarId: process.env.GHL_CALENDAR_ID,
                appointmentStatus: "confirmed",
                assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
                ignoreFreeSlotValidation: true
            };
            console.log("📡 Reschedule Request Body:", JSON.stringify(body, null, 2));
            bookRes = await fetch(updateUrl, {
                method: "PUT",
                headers: getGhlHeaders("2021-04-15"),
                body: JSON.stringify(body)
            });
        } else {
            // Auto-detect if none specified
            const startSearch = new Date();
            const endSearch = new Date();
            endSearch.setDate(endSearch.getDate() + 30);
            const aRes = await fetch(`https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${process.env.GHL_CALENDAR_ID}&startTime=${startSearch.getTime()}&endTime=${endSearch.getTime()}`, { headers: getGhlHeaders() });
            const aData = await aRes.json();
            const existing = (aData?.events || []).find(e => e.contactId === contactId && (e.status === 'booked' || e.status === 'confirmed' || e.status === 'new'));

            if (existing) {
                console.log(`🔄 Auto-rescheduling: ${existing.id}`);
                const body = {
                    startTime,
                    endTime,
                    title: `Voice AI Update: ${firstName}`,
                    calendarId: process.env.GHL_CALENDAR_ID,
                    appointmentStatus: "confirmed",
                    assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
                    ignoreFreeSlotValidation: true
                };
                console.log("📡 Auto-Reschedule Request Body:", JSON.stringify(body, null, 2));
                bookRes = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${existing.id}`, {
                    method: "PUT",
                    headers: getGhlHeaders("2021-04-15"),
                    body: JSON.stringify(body)
                });
            } else {
                console.log("🆕 Booking new appointment...");
                const body = {
                    calendarId: process.env.GHL_CALENDAR_ID,
                    locationId: process.env.GHL_LOCATION_ID,
                    contactId,
                    startTime,
                    endTime,
                    title: `Voice AI Booking: ${firstName}`,
                    appointmentStatus: "confirmed",
                    assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
                    ignoreFreeSlotValidation: true
                };
                console.log("📡 New Booking Request Body:", JSON.stringify(body, null, 2));
                bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
                    method: "POST",
                    headers: getGhlHeaders("2021-04-15"),
                    body: JSON.stringify(body)
                });
            }
        }

        const bData = await bookRes.json();
        if (bookRes.ok) {
            console.log("🤖 AI BOOKING SUCCESS!");
            res.json({ status: "success", message: "Processed successfully!" });
        } else {
            console.error("🤖 GHL REJECTED AI. Status:", bookRes.status);
            console.error("🤖 GHL Error Details:", JSON.stringify(bData, null, 2));
            res.status(400).json({ error: bData.message || "Booking failed" });
        }
    } catch (e) {
        console.error("❌ Fatal Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/retell/cancel_appointment", async (req, res) => {
    console.log("\n🤖 AI CANCEL ATTEMPT...");
    const { args } = req.body;
    const appointmentId = args.appointment_id;
    const phone = args.phone;

    try {
        let targetId = appointmentId;

        // If no ID passed, search for the most upcoming one by phone
        if (!targetId && phone) {
            const cleanPhone = normalizePhone(phone);
            addDebugLog(`Searching for appointment to cancel by phone: ${phone} (Normalized: ${cleanPhone})`);
            const start = new Date();
            const end = new Date();
            end.setDate(end.getDate() + 30);

            const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&number=${encodeURIComponent(cleanPhone)}`;
            const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
            const sData = await sRes.json();
            const contactId = sData?.contact?.id;
            addDebugLog(`Contact search result: ${contactId ? contactId : "NOT FOUND"}`);

            if (contactId) {
                const aRes = await fetch(`https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${process.env.GHL_CALENDAR_ID}&startTime=${start.getTime()}&endTime=${end.getTime()}`, { headers: getGhlHeaders() });
                const aData = await aRes.json();
                const events = aData?.events || [];
                addDebugLog(`Fetched ${events.length} events for the calendar.`);

                const existing = events.find(e => e.contactId === contactId && (e.status === 'booked' || e.status === 'confirmed' || e.status === 'new'));
                if (existing) {
                    addDebugLog(`Found match! Appointment ID: ${existing.id} (Status: ${existing.status})`);
                    targetId = existing.id;
                } else {
                    addDebugLog(`No matching active appointment found for contactId: ${contactId}`);
                }
            }
        }

        if (!targetId) {
            addDebugLog("❌ Cancel Failed: No targetId resolved");
            return res.status(400).json({ error: "No appointment found to cancel" });
        }

        addDebugLog(`🗑️ Cancelling appointment: ${targetId} via PUT status`);
        const delRes = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${targetId}`, {
            method: "PUT",
            headers: getGhlHeaders("2021-04-15"),
            body: JSON.stringify({
                calendarId: process.env.GHL_CALENDAR_ID,
                appointmentStatus: "cancelled"
            })
        });

        if (delRes.ok) {
            console.log("🤖 AI CANCEL SUCCESS!");
            res.json({ status: "success", message: "Appointment cancelled successfully." });
        } else {
            const dData = await delRes.json();
            res.status(400).json({ error: dData.message || "Failed to cancel" });
        }
    } catch (e) {
        console.error("❌ Cancel Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get("/debug/logs", (req, res) => {
    res.send(`
        <html>
            <body style="background: #1e1e1e; color: #00ff00; font-family: monospace; padding: 20px;">
                <h1>🛠️ GHL AGENT DEBUG LOGS</h1>
                <hr/>
                <pre>${debugLogs.join('\n')}</pre>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`\n🚀 GHL Scheduler Debug App running at http://localhost:${PORT}`);
    console.log(`📁 Serving files from: ${join(__dirname, "public")}`);
});
