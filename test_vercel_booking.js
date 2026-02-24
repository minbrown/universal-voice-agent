import fetch from "node-fetch";

async function testVercelBooking() {
    const url = "https://universal-voice-agent.vercel.app/retell/book_appointment";
    const payload = {
        args: {
            first_name: "Debug Test",
            email: "debug@test.com",
            phone: "+15555555555",
            date_time: "2026-02-26T15:30:00-05:00"
        }
    };

    console.log("📡 Sending test booking to Vercel...");
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log("Response:", JSON.stringify(data, null, 2));
}

testVercelBooking();
