import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const fcHeaders = {
    "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    "Content-Type": "application/json"
};

const url = "https://www.jordynshairbeauty.net/";

async function test() {
    console.time("Total");

    // Step 1: Map
    console.log("=== STEP 1: MAP ===");
    console.time("Map");
    let pagesToScrape = [url];
    try {
        const mapRes = await fetch("https://api.firecrawl.dev/v1/map", {
            method: "POST",
            headers: fcHeaders,
            body: JSON.stringify({ url, limit: 20 })
        });
        console.log("Map status:", mapRes.status);
        if (mapRes.ok) {
            const mapData = await mapRes.json();
            const allLinks = (mapData.links || []).map(l => typeof l === 'string' ? l : l.url).filter(Boolean);
            console.log("Links found:", allLinks.length);
            const keyPatterns = /about|contact|service|pricing|price|menu|team|staff|hour|location|faq|policy|policies/i;
            const keyPages = allLinks.filter(link => keyPatterns.test(link));
            pagesToScrape = [...new Set([url, ...keyPages.slice(0, 3)])];
            console.log("Pages to scrape:", pagesToScrape);
        } else {
            const errText = await mapRes.text();
            console.log("Map error:", errText);
        }
    } catch (mapErr) {
        console.log("Map failed:", mapErr.message);
    }
    console.timeEnd("Map");

    // Step 2: Parallel scrape
    console.log("\n=== STEP 2: SCRAPE ===");
    console.time("Scrape");
    const scrapePromises = pagesToScrape.map(pageUrl =>
        fetch("https://api.firecrawl.dev/v1/scrape", {
            method: "POST",
            headers: fcHeaders,
            body: JSON.stringify({
                url: pageUrl,
                formats: ["markdown"],
                onlyMainContent: true
            })
        }).then(async r => {
            const data = r.ok ? await r.json() : null;
            const len = data?.data?.markdown?.length || 0;
            console.log(`  ${pageUrl} => status:${r.status}, ${len} chars`);
            if (!r.ok) console.log("  Error:", await r.text().catch(() => 'n/a'));
            return data;
        }).catch(e => { console.log(`  ${pageUrl} => ERROR: ${e.message}`); return null; })
    );
    const scrapeResults = await Promise.all(scrapePromises);
    console.timeEnd("Scrape");

    // Combine
    let combinedContent = "";
    for (let i = 0; i < scrapeResults.length; i++) {
        const result = scrapeResults[i];
        if (result?.data?.markdown) {
            const pageTitle = result.data.metadata?.title || pagesToScrape[i];
            combinedContent += `\n\n--- ${pageTitle} ---\n${result.data.markdown}`;
        }
    }

    const trimmed = combinedContent.substring(0, 6000);
    console.log("\n=== RESULT ===");
    console.log("Combined length:", combinedContent.length);
    console.log("Trimmed length:", trimmed.length);
    console.log("\nFirst 500 chars of context:");
    console.log(trimmed.substring(0, 500));
    console.log("\n... includes address?", trimmed.includes("37276") || trimmed.includes("Livonia"));
    console.log("... includes pricing?", /\$?\d{2,3}/.test(trimmed));

    console.timeEnd("Total");
}

test().catch(e => console.error(e)).finally(() => process.exit(0));
