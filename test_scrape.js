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
    const mapRes = await fetch("https://api.firecrawl.dev/v1/map", {
        method: "POST",
        headers: fcHeaders,
        body: JSON.stringify({ url, limit: 20 })
    });
    const mapData = await mapRes.json();
    console.timeEnd("Map");
    console.log("Map status:", mapRes.status);

    const allLinks = (mapData.links || []).map(l => typeof l === 'string' ? l : l.url).filter(Boolean);
    console.log("All links found:", allLinks.length);
    allLinks.forEach(l => console.log("  ", l));

    const keyPatterns = /about|contact|service|pricing|price|menu|team|staff|hour|location|faq|policy|policies/i;
    const keyPages = allLinks.filter(link => keyPatterns.test(link));
    console.log("Key pages:", keyPages);

    let pagesToScrape = [url, ...keyPages.slice(0, 3)];
    pagesToScrape = [...new Set(pagesToScrape)];
    console.log("Will scrape:", pagesToScrape);

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
                onlyMainContent: true,
                waitFor: 5000
            })
        }).then(async r => {
            const data = r.ok ? await r.json() : null;
            console.log(`  ${pageUrl} => ${r.status}, ${data?.data?.markdown?.length || 0} chars`);
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
            combinedContent += `\n\n=== PAGE: ${pagesToScrape[i]} ===\n${result.data.markdown}`;
        }
    }
    console.log("\nCombined content length:", combinedContent.length);
    const trimmed = combinedContent.substring(0, 8000);

    // Step 3: Extract
    console.log("\n=== STEP 3: EXTRACT ===");
    console.time("Extract");
    const extractRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: fcHeaders,
        body: JSON.stringify({
            url,
            formats: ["json"],
            jsonOptions: {
                prompt: `Analyze this combined website content and extract ALL business details. Be thorough:\n\n${trimmed}`,
                schema: {
                    type: "object",
                    properties: {
                        business_name: { type: "string" },
                        business_summary: { type: "string" },
                        owner_name: { type: "string" },
                        contact_phone: { type: "string" },
                        contact_email: { type: "string" },
                        address: { type: "string" },
                        business_hours: { type: "string" },
                        services: {
                            type: "array", items: {
                                type: "object", properties: {
                                    name: { type: "string" }, price: { type: "string" }, description: { type: "string" }, duration: { type: "string" }
                                }
                            }
                        }
                    }
                }
            }
        })
    });
    console.timeEnd("Extract");
    console.log("Extract status:", extractRes.status);
    const extractData = await extractRes.json();
    console.log("Extract result:", JSON.stringify(extractData?.data?.json, null, 2));

    console.timeEnd("Total");
}

test().catch(e => console.error(e)).finally(() => process.exit(0));
