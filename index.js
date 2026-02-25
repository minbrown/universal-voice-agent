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
        // Force timezone to matching calendar's offset or UTC to be safe, but GHL usually returns local.
        // We add strict filtering after fetch.
        const slotsUrl = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${sevenDays.getTime()}`;
        const slotsRes = await fetch(slotsUrl, { headers: getGhlHeaders() });
        const slotsData = await slotsRes.json();

        let availableSlots = [];
        const bufferTime = now.getTime() + (60 * 60 * 1000); // 1 hour buffer from now

        Object.keys(slotsData).forEach(day => {
            if (slotsData[day]?.slots) {
                const futureSlots = slotsData[day].slots.filter(s => new Date(s).getTime() > bufferTime);
                availableSlots.push(...futureSlots);
            }
        });

        // 2. Identify all caller appointments
        let existingAppointments = [];

        if (phone || email) {
            const cleanPhone = phone ? normalizePhone(phone) : null;
            const searchVal = cleanPhone || email;
            const searchKey = cleanPhone ? "query" : "email";

            addDebugLog(`Deep search started for ${searchKey}: ${searchVal}`);

            // Search ALL contacts matching the query (broader than 'duplicate' search)
            const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&${searchKey}=${encodeURIComponent(searchVal)}`;
            const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
            const sData = await sRes.json();
            const contacts = sData?.contacts || [];

            addDebugLog(`Deep search found ${contacts.length} potential contact records.`);

            for (const contact of contacts) {
                const cId = contact.id;
                addDebugLog(`Checking contact: ${contact.firstName || "Unnamed"} (${cId})`);

                const apptUrl = `https://services.leadconnectorhq.com/contacts/${cId}/appointments`;
                const aRes = await fetch(apptUrl, { headers: getGhlHeaders() });
                const aData = await aRes.json();
                const appts = aData?.appointments || [];
                const nowMs = new Date().getTime();

                const matched = appts
                    .filter(e => {
                        const status = (e.appointmentStatus || e.status || "").toLowerCase();
                        return e.calendarId === calendarId &&
                            (status === 'booked' || status === 'confirmed' || status === 'new') &&
                            new Date(e.startTime).getTime() > nowMs;
                    })
                    .map(e => ({
                        appointment_id: e.id,
                        time: e.startTime,
                        title: e.title || "Appointment"
                    }));

                if (matched.length > 0) {
                    addDebugLog(`🏆 Found ${matched.length} appointments on contact ${cId}`);
                    existingAppointments.push(...matched);
                }
            }

            // Deduplicate appointments by ID
            existingAppointments = Array.from(new Map(existingAppointments.map(a => [a.appointment_id, a])).values());

            // Mega Fallback: Scan ALL calendar events for the phone number string if we still have nothing
            if (existingAppointments.length === 0 && cleanPhone) {
                try {
                    addDebugLog(`🔦 Starting Mega Scanner (Absolute Scan) for ${cleanPhone}...`);
                    const megaUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${now.getTime()}&endTime=${future.getTime()}`;
                    const megaRes = await fetch(megaUrl, { headers: getGhlHeaders() });
                    const megaData = await megaRes.json();
                    const events = megaData?.events || [];

                    for (const event of events) {
                        const status = (event.appointmentStatus || event.status || "").toLowerCase();
                        if (status !== 'booked' && status !== 'confirmed' && status !== 'new') continue;

                        // 1. Check title/address directly
                        const eventStr = JSON.stringify(event).toLowerCase();
                        if (eventStr.includes(cleanPhone)) {
                            addDebugLog(`🏆 Mega Scanner match by text: ${event.id}`);
                            existingAppointments.push({
                                appointment_id: event.id,
                                time: event.startTime,
                                title: event.title || "Found by Scan"
                            });
                            continue;
                        }

                        // 2. Deep link: Check the contact record for this specific event
                        if (event.contactId) {
                            const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${event.contactId}`, { headers: getGhlHeaders() });
                            const cData = await cRes.json();
                            const cPhone = normalizePhone(cData?.contact?.phone);

                            if (cPhone === cleanPhone) {
                                addDebugLog(`🏆 Mega Scanner match by Deep Contact Link: ${event.id}`);
                                existingAppointments.push({
                                    appointment_id: event.id,
                                    time: event.startTime,
                                    title: event.title || "Found by Deep Scan"
                                });
                            }
                        }
                    }
                } catch (megaErr) {
                    addDebugLog(`⚠️ Mega Scanner failed: ${megaErr.message}`);
                }
            }

            addDebugLog(`Total distinct future appointments identified: ${existingAppointments.length}`);
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
    const lastName = args.last_name || args.lastName || "";
    const email = args.email;
    const phone = args.phone;
    const slot = args.date_time || args.dateTime;
    const appointmentId = args.appointment_id; // Targeted reschedule

    addDebugLog(`Booking/Reschedule requested for ${firstName} at ${slot} (ID: ${appointmentId})`);

    if (!slot) {
        addDebugLog("❌ Missing slot/date_time");
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
            addDebugLog(`🔄 Updating contact ${contactId} with last name ${lastName}...`);
            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                method: "PUT",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, lastName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
        } else {
            addDebugLog(`🆕 Creating contact with last name ${lastName}...`);
            const cRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
                method: "POST",
                headers: getGhlHeaders(),
                body: JSON.stringify({ firstName, lastName, email, phone, locationId: process.env.GHL_LOCATION_ID })
            });
            const cData = await cRes.json();
            contactId = cData?.contact?.id;
        }

        if (!contactId) {
            addDebugLog("❌ Failed to resolve contact ID for booking");
            throw new Error("Failed to resolve contact ID");
        }
        addDebugLog(`Contact resolved: ${contactId}`);

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
                locationId: process.env.GHL_LOCATION_ID,
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
            // Auto-detect if none specified (Deep Search across all potential records)
            const cleanPhone = normalizePhone(phone);
            const searchVal = cleanPhone || email;
            const searchKey = cleanPhone ? "query" : "email";

            const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&${searchKey}=${encodeURIComponent(searchVal)}`;
            const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
            const sData = await sRes.json();
            const contacts = sData?.contacts || [];
            const calendarId = process.env.GHL_CALENDAR_ID;
            const nowMs = new Date().getTime();

            let existing = null;

            // 1. Check all matching contacts
            for (const contact of contacts) {
                const cId = contact.id;
                const aRes = await fetch(`https://services.leadconnectorhq.com/contacts/${cId}/appointments`, { headers: getGhlHeaders() });
                const aData = await aRes.json();
                const appointments = aData?.appointments || [];

                existing = appointments.find(e => {
                    const status = (e.appointmentStatus || e.status || "").toLowerCase();
                    return e.calendarId === calendarId &&
                        (status === 'booked' || status === 'confirmed' || status === 'new') &&
                        new Date(e.startTime).getTime() > nowMs;
                });

                if (existing) {
                    addDebugLog(`🏆 Auto-reschedule found match on contact ${cId}: ${existing.id}`);
                    break;
                }
            }

            if (!existing) {
                addDebugLog("🤷 No appointment found via contact search for reschedule.");
            }

            // 2. Mega Scanner Fallback (Absolute Scan)
            if (!existing && cleanPhone) {
                try {
                    addDebugLog(`🔦 Auto-reschedule starting Mega Scanner for ${cleanPhone}...`);
                    const future = new Date(nowMs + (30 * 24 * 60 * 60 * 1000));
                    const megaUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${nowMs}&endTime=${future.getTime()}`;
                    const megaRes = await fetch(megaUrl, { headers: getGhlHeaders() });
                    const megaData = await megaRes.json();
                    const events = megaData?.events || [];

                    for (const event of events) {
                        const status = (event.appointmentStatus || event.status || "").toLowerCase();
                        if (status !== 'booked' && status !== 'confirmed' && status !== 'new') continue;

                        if (JSON.stringify(event).includes(cleanPhone)) {
                            existing = event;
                            addDebugLog(`🏆 Mega Scanner SAVED Auto-Reschedule: ${existing.id}`);
                            break;
                        }
                        if (event.contactId) {
                            const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${event.contactId}`, { headers: getGhlHeaders() });
                            const cData = await cRes.json();
                            if (normalizePhone(cData?.contact?.phone) === cleanPhone) {
                                existing = event;
                                addDebugLog(`🏆 Mega Scanner Deep Match SAVED Auto-Reschedule: ${existing.id}`);
                                break;
                            }
                        }
                    }
                } catch (e) { addDebugLog(`⚠️ Mega Scan Reschedule error: ${e.message}`); }
            }

            if (existing) {
                addDebugLog(`🔄 Executing Reschedule for: ${existing.id}`);
                const body = {
                    startTime,
                    endTime,
                    title: `Voice AI Update: ${firstName}`,
                    calendarId: process.env.GHL_CALENDAR_ID,
                    locationId: process.env.GHL_LOCATION_ID,
                    appointmentStatus: "confirmed",
                    assignedUserId: process.env.GHL_ASSIGNED_USER_ID,
                    ignoreFreeSlotValidation: true
                };
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
                    title: `Voice AI Booking: ${firstName} ${lastName}`,
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
            addDebugLog(`✅ GHL Success: ${appointmentId || existing?.id || "NEW"}`);
            res.json({ status: "success", message: "Processed successfully!" });
        } else {
            addDebugLog(`❌ GHL Rejected (${bookRes.status}): ${JSON.stringify(bData)}`);
            res.status(400).json({ error: bData.message || "Booking failed" });
        }
    } catch (e) {
        addDebugLog(`❌ Fatal Booking Error: ${e.message}`);
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

            const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&query=${encodeURIComponent(cleanPhone)}`;
            const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
            const sData = await sRes.json();
            const contacts = sData?.contacts || [];

            addDebugLog(`Cancellation deep search found ${contacts.length} potential contact records.`);

            for (const contact of contacts) {
                const cId = contact.id;
                const apptUrl = `https://services.leadconnectorhq.com/contacts/${cId}/appointments`;
                const aRes = await fetch(apptUrl, { headers: getGhlHeaders() });
                const aData = await aRes.json();
                const appointments = aData?.appointments || [];
                const nowMs = new Date().getTime();
                const calendarId = process.env.GHL_CALENDAR_ID;

                const existing = appointments.find(e => {
                    const status = (e.appointmentStatus || e.status || "").toLowerCase();
                    return e.calendarId === calendarId &&
                        (status === 'booked' || status === 'confirmed' || status === 'new') &&
                        new Date(e.startTime).getTime() > nowMs;
                });

                if (existing) {
                    addDebugLog(`🏆 Found match to cancel on contact ${cId}! Appointment ID: ${existing.id}`);
                    targetId = existing.id;
                    break;
                }
            }

            if (!targetId) {
                addDebugLog(`🔦 Starting Mega Scanner for Cancellation (${cleanPhone})...`);
                const calendarId = process.env.GHL_CALENDAR_ID;
                const nowMs = new Date().getTime();
                const future = new Date(nowMs + (30 * 24 * 60 * 60 * 1000));

                const megaUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${nowMs}&endTime=${future.getTime()}`;
                const megaRes = await fetch(megaUrl, { headers: getGhlHeaders() });
                const megaData = await megaRes.json();
                const events = megaData?.events || [];

                for (const event of events) {
                    const status = (event.appointmentStatus || event.status || "").toLowerCase();
                    if (status !== 'booked' && status !== 'confirmed' && status !== 'new') continue;

                    // 1. Text match
                    if (JSON.stringify(event).includes(cleanPhone)) {
                        addDebugLog(`🏆 Mega Scanner match (Cancel): ${event.id}`);
                        targetId = event.id;
                        break;
                    }
                    // 2. Deep contact match
                    if (event.contactId) {
                        const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${event.contactId}`, { headers: getGhlHeaders() });
                        const cData = await cRes.json();
                        if (normalizePhone(cData?.contact?.phone) === cleanPhone) {
                            addDebugLog(`🏆 Mega Scanner Deep Match (Cancel): ${event.id}`);
                            targetId = event.id;
                            break;
                        }
                    }
                }
            }

            if (!targetId) {
                addDebugLog(`No matching active FUTURE appointment found for ${cleanPhone} across ${contacts.length} records + Mega Scan.`);
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
    const logsHtml = debugLogs.map(log => `<div>${log}</div>`).join("");
    res.send(`
        <html>
            <head>
                <style>
                    body { font-family: monospace; background: #121212; color: #00ff00; padding: 20px; }
                    div { border-bottom: 1px solid #333; padding: 5px 0; }
                    .header { color: #fff; font-size: 20px; margin-bottom: 20px; border-bottom: 2px solid #00ff00; }
                </style>
            </head>
            <body>
                <div class="header">🛠️ GHL AGENT DEBUG LOGS</div>
                <div style="margin-bottom: 20px; color: #aaa;">
                    Endpoints: <a href="/debug/logs" style="color: #00ff00;">/logs</a> | 
                    <a href="/debug/raw-calendar" style="color: #00ff00;">/raw-calendar</a>
                </div>
                ${logsHtml}
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
        </html>
    `);
});

app.get("/debug/raw-calendar", async (req, res) => {
    try {
        const calendarId = process.env.GHL_CALENDAR_ID;
        const now = new Date();
        const future = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
        const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${now.getTime()}&endTime=${future.getTime()}`;
        const response = await fetch(url, { headers: getGhlHeaders() });
        const data = await response.json();
        res.json({
            config: { calendarId, locationId: process.env.GHL_LOCATION_ID },
            data
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/retell/get_contact_info", async (req, res) => {
    addDebugLog("🤖 AI LOOKUP CONTACT...");
    const { args } = req.body;
    const phone = args.phone;

    if (!phone) return res.status(400).json({ error: "Missing phone" });

    try {
        const cleanPhone = normalizePhone(phone);
        const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&query=${encodeURIComponent(cleanPhone)}`;
        const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
        const sData = await sRes.json();
        const contact = sData?.contacts?.[0];

        if (contact) {
            addDebugLog(`🏆 Found existing contact: ${contact.firstName} ${contact.lastName || ""}`);
            res.json({
                found: true,
                contact_id: contact.id,
                name: contact.firstName,
                last_name: contact.lastName || "",
                email: contact.email,
                phone: contact.phone
            });
        } else {
            addDebugLog("🤷 No contact found for greeting.");
            res.json({ found: false });
        }
    } catch (err) {
        addDebugLog(`❌ Lookup Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post("/retell/update_contact_info", async (req, res) => {
    addDebugLog("🤖 AI UPDATE CONTACT...");
    const { args } = req.body;
    const { phone, first_name, last_name, email } = args;

    if (!phone) return res.status(400).json({ error: "Missing phone" });

    try {
        const cleanPhone = normalizePhone(phone);
        const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&query=${encodeURIComponent(cleanPhone)}`;
        const sRes = await fetch(searchUrl, { headers: getGhlHeaders() });
        const sData = await sRes.json();
        let contact = sData?.contacts?.[0];

        if (contact) {
            addDebugLog(`🔄 Updating contact ${contact.id}...`);
            const updateRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contact.id}`, {
                method: "PUT",
                headers: getGhlHeaders(),
                body: JSON.stringify({
                    firstName: first_name || contact.firstName,
                    lastName: last_name || contact.lastName,
                    email: email || contact.email,
                    phone: phone,
                    locationId: process.env.GHL_LOCATION_ID
                })
            });
            if (updateRes.ok) {
                addDebugLog("✅ Contact updated successfully.");
                res.json({ status: "success" });
            } else {
                throw new Error("GHL update failed");
            }
        } else {
            addDebugLog("🆕 Creating NEW contact for update...");
            const createRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
                method: "POST",
                headers: getGhlHeaders(),
                body: JSON.stringify({
                    firstName: first_name || "New Contact",
                    lastName: last_name || "",
                    email: email,
                    phone: phone,
                    locationId: process.env.GHL_LOCATION_ID
                })
            });
            if (createRes.ok) {
                addDebugLog("✅ Contact created successfully.");
                res.json({ status: "success" });
            } else {
                throw new Error("GHL creation failed");
            }
        }
    } catch (err) {
        addDebugLog(`❌ Update Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 GHL Scheduler Debug App running at http://localhost:${PORT}`);
    console.log(`📁 Serving files from: ${join(__dirname, "public")}`);
});
