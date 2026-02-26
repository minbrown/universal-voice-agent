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
    if (req.url.startsWith("/retell/")) {
        addDebugLog(`${req.method} ${req.url} | Body: ${JSON.stringify(req.body)}`);
    } else {
        addDebugLog(`${req.method} ${req.url}`);
    }
    next();
});

const normalizePhone = (phone) => {
    if (!phone || typeof phone !== 'string') return null;
    let digits = phone.replace(/\D/g, '');
    if (digits.length > 10) digits = digits.slice(-10);
    return digits;
};

const resolvePhone = (req) => {
    const { args, call } = req.body;
    let phone = args?.phone || args?.phoneNumber || args?.user_phone_number;

    // If phone looks like a template tag or is non-string, clear it to trigger fallback
    if (phone && (typeof phone !== 'string' || phone.includes("{{") || phone.includes("undefined"))) {
        phone = null;
    }

    // Fallback to Retell Metadata (phone calls have from_number, web calls have metadata)
    if (!phone) {
        phone = call?.from_number || call?.user_phone_number || call?.metadata?.phone;
    }

    return phone;
};

app.use(express.static(join(__dirname, "public")));

/**
 * RETELL WEB CALL: Support for the online widget
 */
app.post("/retell/create-web-call", async (req, res) => {
    addDebugLog("🤖 CREATING WEB CALL SESSION...");
    try {
        const response = await fetch("https://api.retellai.com/v2/create-web-call", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent_id: process.env.RETELL_AGENT_ID,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            addDebugLog(`❌ Retell Web Call Error: ${JSON.stringify(errorData)}`);
            throw new Error(errorData.message || "Failed to create web call");
        }

        const data = await response.json();
        addDebugLog(`✅ Web Call Session Created: ${data.call_id}`);
        res.json(data);
    } catch (err) {
        addDebugLog(`❌ Web Call Session Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "public", "index.html"));
});

/**
 * FIRECRAWL UTILITY: Scrape business context for demos
 */
const scrapeBusinessContext = async (url) => {
    if (!url) return "General business information";
    addDebugLog(`🔥 Scraping website: ${url}`);
    try {
        const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                url,
                formats: ["json"],
                jsonOptions: {
                    prompt: "Extract compelling sales info: unique selling points, detailed service tiers with pricing, and FAQs that handle common objections.",
                    schema: {
                        type: "object",
                        properties: {
                            business_summary: { type: "string" },
                            unique_selling_points: { type: "array", items: { type: "string" } },
                            services: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: { type: "string" }, description: { type: "string" } } } },
                            business_hours: { type: "string" },
                            location_details: { type: "string" },
                            faqs: { type: "array", items: { type: "object", properties: { q: { type: "string" }, a: { type: "string" } } } }
                        }
                    }
                }
            })
        });

        if (!response.ok) throw new Error("Firecrawl failed");
        const data = await response.json();
        const content = data.data.json;

        return `
            Bio: ${content.business_summary || "N/A"}
            USPs: ${(content.unique_selling_points || []).join(" | ")}
            Services: ${(content.services || []).map(s => `${s.name}: ${s.price || 'Contact'} (${s.description || ''})`).join(" || ")}
            Hours: ${content.business_hours || "N/A"}
            Location: ${content.location_details || "N/A"}
            FAQs: ${(content.faqs || []).map(f => `Q: ${f.q} A: ${f.a}`).join(" | ")}
        `.trim();
    } catch (err) {
        addDebugLog(`⚠️ Scraping failed for ${url}: ${err.message}`);
        return "General business excellence and high-quality service.";
    }
};

/**
 * DEMO PIPELINE: Lead capture -> Scrape -> Personalized Call
 */
app.post("/api/start-demo", async (req, res) => {
    addDebugLog("🚀 STARTING DEMO PIPELINE...");
    const { firstName, lastName, phone, email, companyName, websiteURL } = req.body;

    if (!phone || !firstName) {
        return res.status(400).json({ error: "Missing required lead info (Name, Phone)" });
    }

    try {
        // 1. Create/Update Lead in GHL
        addDebugLog(`👤 Syncing lead: ${firstName} ${lastName || ""} (${companyName || "No Company"})`);
        const contactRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
            method: "POST",
            headers: getGhlHeaders(),
            body: JSON.stringify({
                firstName,
                lastName: lastName || "",
                name: `${firstName} ${lastName || ""}`.trim(),
                email,
                phone,
                companyName,
                website: websiteURL,
                locationId: process.env.GHL_LOCATION_ID,
                tags: ["AI-Demo-Lead", "Web-Widget"]
            })
        });

        // 2. Scrape Website for Context
        const businessContext = await scrapeBusinessContext(websiteURL);
        addDebugLog("📝 Context extracted successfully.");

        // 3. Initialize Personalized Retell Session
        addDebugLog("🎙️ Initializing personalized Retell session...");
        const retellResponse = await fetch("https://api.retellai.com/v2/create-web-call", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agent_id: process.env.RETELL_AGENT_ID,
                metadata: {
                    phone,
                    email,
                    firstName,
                    lastName: lastName || "",
                    companyName: companyName || ""
                },
                retell_llm_dynamic_variables: {
                    "contact_first_name": firstName,
                    "contact_last_name": lastName || "",
                    "contact_phone": phone,
                    "contact_email": email || "",
                    "contact_company_name": companyName || "your business",
                    "business_context": businessContext,
                    "current_date": new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" }),
                    "current_time": new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
                }
            }),
        });

        if (!retellResponse.ok) {
            const error = await retellResponse.json();
            throw new Error(error.message || "Retell session failed");
        }

        const retellData = await retellResponse.json();
        addDebugLog(`✅ Demo session ready: ${retellData.call_id}`);

        res.json({
            success: true,
            access_token: retellData.access_token,
            call_id: retellData.call_id
        });

    } catch (err) {
        addDebugLog(`❌ Demo Pipeline Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

const findContactByPhoneOrEmail = async (phone, email) => {
    const cleanPhone = normalizePhone(phone);

    // Strategy 1: Try E.164 format first (e.g. +15551234567)
    if (phone && phone !== cleanPhone) {
        try {
            const dupUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&number=${encodeURIComponent(phone)}`;
            const res = await fetch(dupUrl, { headers: getGhlHeaders() });
            const data = await res.json();
            if (data?.contact) {
                addDebugLog(`🏆 Found contact by E.164 phone: ${data.contact.id}`);
                return data.contact;
            }
        } catch (e) {
            addDebugLog(`⚠️ E.164 phone search failed: ${e.message}`);
        }
    }

    // Strategy 2: Try normalized 10-digit phone
    if (cleanPhone) {
        try {
            const dupUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${process.env.GHL_LOCATION_ID}&number=${encodeURIComponent(cleanPhone)}`;
            const res = await fetch(dupUrl, { headers: getGhlHeaders() });
            const data = await res.json();
            if (data?.contact) {
                addDebugLog(`🏆 Found contact by normalized phone: ${data.contact.id}`);
                return data.contact;
            }
        } catch (e) {
            addDebugLog(`⚠️ Normalized phone search failed: ${e.message}`);
        }

        // Strategy 3: General query search by phone
        try {
            const queryUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&query=${encodeURIComponent(cleanPhone)}`;
            const res = await fetch(queryUrl, { headers: getGhlHeaders() });
            const data = await res.json();
            const contact = data?.contacts?.[0];
            if (contact) {
                addDebugLog(`🏆 Found contact by query: ${contact.id}`);
                return contact;
            }
        } catch (e) {
            addDebugLog(`⚠️ Query search failed: ${e.message}`);
        }
    }

    // Strategy 4: Fallback to email search
    if (email) {
        try {
            const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
            const res = await fetch(searchUrl, { headers: getGhlHeaders() });
            const data = await res.json();
            const contact = data?.contacts?.[0];
            if (contact) {
                addDebugLog(`🏆 Found contact by email: ${contact.id}`);
                return contact;
            }
        } catch (e) {
            addDebugLog(`⚠️ Email search failed: ${e.message}`);
        }
    }

    addDebugLog(`❌ No contact found for phone: ${phone}, email: ${email}`);
    return null;
};

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
    const { args, call } = req.body;
    const phone = resolvePhone(req);
    const email = args?.email || call?.metadata?.email;

    // Detailed logging for phone resolution debugging
    addDebugLog(`📞 Phone resolution: args.phone=${args?.phone}, call.from_number=${call?.from_number}, metadata.phone=${call?.metadata?.phone}, resolved=${phone}`);

    const calendarId = process.env.GHL_CALENDAR_ID;
    const now = new Date();

    addDebugLog(`Availability requested for Phone: ${phone}, Email: ${email}`);

    try {
        // 1. Fetch free slots (7-day window)
        const sevenDays = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        const slotsUrl = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${now.getTime()}&endDate=${sevenDays.getTime()}`;
        const slotsRes = await fetch(slotsUrl, { headers: getGhlHeaders() });
        const slotsData = await slotsRes.json();

        let availableSlots = [];
        const bufferTime = now.getTime() + (60 * 60 * 1000); // 1 hour buffer

        Object.keys(slotsData).forEach(day => {
            if (slotsData[day]?.slots) {
                const futureSlots = slotsData[day].slots.filter(s => new Date(s).getTime() > bufferTime);
                availableSlots.push(...futureSlots);
            }
        });

        addDebugLog(`Found ${availableSlots.length} available slots`);

        // 2. Quick check for existing appointments (single contact lookup, no mega scan)
        let existingAppointments = [];
        let contactName = null;

        if (phone || email) {
            const contact = await findContactByPhoneOrEmail(phone, email);
            if (contact) {
                contactName = contact.firstName || null;
                addDebugLog(`Found contact: ${contact.firstName} ${contact.lastName || ""} (${contact.id})`);

                // Use calendar events endpoint (contacts/{id}/appointments returns empty!)
                const futureMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;
                const eventsUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${now.getTime()}&endTime=${futureMs}`;
                const eRes = await fetch(eventsUrl, { headers: getGhlHeaders() });
                const eData = await eRes.json();
                const events = eData?.events || [];

                existingAppointments = events
                    .filter(e => {
                        const status = (e.appointmentStatus || e.status || "").toLowerCase();
                        return e.contactId === contact.id &&
                            (status === 'booked' || status === 'confirmed' || status === 'new');
                    })
                    .map(e => ({
                        appointment_id: e.id,
                        time: e.startTime,
                        title: e.title || "Appointment"
                    }));
            } else {
                addDebugLog(`❌ No contact found for phone=${phone}, email=${email}`);
            }
        }

        addDebugLog(`Result: ${availableSlots.length} slots, ${existingAppointments.length} existing appointments, contact=${contactName}`);

        res.json({
            available_slots: availableSlots.slice(0, 5),
            existing_appointments: existingAppointments,
            contact_name: contactName
        });
    } catch (err) {
        console.error("❌ Availability Error:", err.message);
        addDebugLog(`❌ Availability Error: ${err.message}`);
        res.status(500).json({ error: "GHL sync failed" });
    }
});

app.post("/retell/book_appointment", async (req, res) => {
    console.log("\n🤖 AI BOOKING ATTEMPT...");
    const { args, call } = req.body;
    const phone = resolvePhone(req);
    const firstName = args.first_name || args.firstName || call?.metadata?.firstName || "Unknown";
    const lastName = args.last_name || args.lastName || call?.metadata?.lastName || "";
    const email = args.email || call?.metadata?.email;
    const slot = args.date_time || args.dateTime;
    const appointmentId = args.appointment_id; // Targeted reschedule

    addDebugLog(`Booking/Reschedule requested for ${firstName} at ${slot} (ID: ${appointmentId})`);

    if (!slot) {
        addDebugLog("❌ Missing slot/date_time");
        return res.status(400).json({ error: "Missing slot/date_time" });
    }

    try {
        let contactId = null;

        // Search for existing contact robustly
        const existing = await findContactByPhoneOrEmail(phone, email);
        if (existing) contactId = existing.id;

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

        // Always cancel existing future appointments for this contact before creating new
        if (contactId) {
            try {
                // Use calendar events endpoint (contacts/{id}/appointments returns empty!)
                const now = Date.now();
                const future = now + 30 * 24 * 60 * 60 * 1000;
                const eventsUrl = `https://services.leadconnectorhq.com/calendars/events?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${process.env.GHL_CALENDAR_ID}&startTime=${now}&endTime=${future}`;
                const eRes = await fetch(eventsUrl, { headers: getGhlHeaders() });
                const eData = await eRes.json();
                const events = eData?.events || [];

                const futureAppts = events.filter(e => {
                    const status = (e.appointmentStatus || e.status || "").toLowerCase();
                    return e.contactId === contactId &&
                        (status === 'booked' || status === 'confirmed' || status === 'new');
                });

                addDebugLog(`Found ${futureAppts.length} existing appointments for contact ${contactId} to cancel`);

                for (const old of futureAppts) {
                    addDebugLog(`🗑️ Cancelling old appointment: ${old.id} at ${old.startTime}`);
                    const cancelRes = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${old.id}`, {
                        method: "PUT",
                        headers: getGhlHeaders("2021-04-15"),
                        body: JSON.stringify({
                            calendarId: process.env.GHL_CALENDAR_ID,
                            locationId: process.env.GHL_LOCATION_ID,
                            appointmentStatus: "cancelled"
                        })
                    });
                    const cancelData = await cancelRes.json();
                    addDebugLog(`Cancel response (${cancelRes.status}): ${JSON.stringify(cancelData).substring(0, 200)}`);
                }
                if (futureAppts.length > 0) {
                    addDebugLog(`✅ Cancelled ${futureAppts.length} old appointment(s)`);
                }
            } catch (cancelErr) {
                addDebugLog(`⚠️ Auto-cancel failed: ${cancelErr.message}`);
            }
        }

        // Always create a fresh booking
        console.log("🆕 Booking new appointment...");
        const newBody = {
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
        addDebugLog(`📡 New Booking: ${JSON.stringify(newBody)}`);
        bookRes = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
            method: "POST",
            headers: getGhlHeaders("2021-04-15"),
            body: JSON.stringify(newBody)
        });

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
    console.log("\n🤖 AI CANCELLING...");
    const { args } = req.body;
    const phone = resolvePhone(req);
    let targetId = args.appointment_id;

    try {
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
    const phone = resolvePhone(req);

    if (!phone) {
        addDebugLog("❌ Could not resolve phone for lookup.");
        return res.status(400).json({ error: "Missing phone" });
    }

    try {
        const contact = await findContactByPhoneOrEmail(phone, null);

        if (contact) {
            addDebugLog(`🏆 Found existing contact: ${contact.firstName} ${contact.lastName || ""}`);
            res.json({
                found: true,
                resolved_phone: phone, // Tell the agent we found their real number
                contact_id: contact.id,
                name: contact.firstName,
                last_name: contact.lastName || "",
                email: contact.email,
                phone: contact.phone,
                message: `I found a profile for ${contact.firstName} ${contact.lastName || ""} associated with number ${phone}.`
            });
        } else {
            addDebugLog(`🤷 No contact found for ${phone}.`);
            res.json({
                found: false,
                resolved_phone: phone,
                message: `I couldn't find a profile for the number ${phone}. You should ask the caller for their name.`
            });
        }
    } catch (err) {
        addDebugLog(`❌ Lookup Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post("/retell/update_contact_info", async (req, res) => {
    addDebugLog("🤖 AI UPDATE CONTACT...");
    const { args } = req.body;
    const phone = resolvePhone(req);
    const { first_name, last_name, email } = args;

    if (!phone) {
        addDebugLog("❌ Could not resolve phone for update.");
        return res.status(400).json({ error: "Missing phone" });
    }

    try {
        const contact = await findContactByPhoneOrEmail(phone, email);

        if (contact) {
            addDebugLog(`🔄 Updating contact ${contact.id} (Name: ${first_name}, Last: ${last_name})...`);
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
            const updateData = await updateRes.json();
            if (updateRes.ok) {
                addDebugLog("✅ Contact updated successfully.");
                res.json({ status: "success", message: "Contact updated in GHL." });
            } else {
                addDebugLog(`❌ GHL Update Error: ${JSON.stringify(updateData)}`);
                throw new Error(updateData.message || "GHL update failed");
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
            const createData = await createRes.json();
            if (createRes.ok) {
                addDebugLog("✅ Contact created successfully.");
                res.json({ status: "success", message: "New contact created in GHL." });
            } else {
                addDebugLog(`❌ GHL Creation Error: ${JSON.stringify(createData)}`);
                throw new Error(createData.message || "GHL creation failed");
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
