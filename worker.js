export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const zip = url.searchParams.get("zip");

    // 1. Fetch the static index.html file from Cloudflare Assets
    const assetResponse = await env.ASSETS.fetch(request);

    // If no ZIP code was provided in the query params, return the blank search form
    if (!zip) {
      return assetResponse;
    }

    try {
      // 2. Query Google Civic API for federal lawmakers
      // Requires CIVIC_API_KEY set in your Cloudflare environment secrets
      const civicApiKey = env.CIVIC_API_KEY || "";
      const civicUrl = `https://civicinfo.googleapis.com/civicinfo/v2/representatives?address=${encodeURIComponent(
        zip
      )}&levels=country&roles=legislatorLowerBody&roles=legislatorUpperBody&key=${civicApiKey}`;

      const civicReq = await fetch(civicUrl);
      const civicData = await civicReq.json();

      let representativesHtml = "";

      // 3. Process the Google Civic response
      if (civicData.offices && civicData.officials) {
        for (const office of civicData.offices) {
          for (const index of office.officialIndices) {
            const official = civicData.officials[index];
            const officeTitle = office.name;

            // --- A. Map Local & D.C. Office Addresses ---
            let addressesHtml = "";
            if (official.address && official.address.length > 0) {
              official.address.forEach((addr) => {
                addressesHtml += `
                  <div class="office-card" style="margin-bottom: 10px; padding: 12px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa;">
                    <strong>${addr.city || "Primary"} Office</strong><br>
                    ${addr.line1 ? addr.line1 + "<br>" : ""}
                    ${addr.city}, ${addr.state} ${addr.zip}
                  </div>
                `;
              });
            } else {
              addressesHtml = `<p><em>No public office addresses listed.</em></p>`;
            }

            // --- B. Query OpenFEC API for Top Donors ---
            let donorHtml = `<p><em>Financial donor data unavailable.</em></p>`;
            const fecApiKey = env.FEC_API_KEY || "DEMO_KEY";

            try {
              // Step 1: Search FEC for candidate's committee ID
              const fecSearchUrl = `https://api.open.fec.gov/v1/candidates/search/?q=${encodeURIComponent(
                official.name
              )}&api_key=${fecApiKey}&sort_null_only=false`;
              
              const fecSearchReq = await fetch(fecSearchUrl);
              const fecSearchData = await fecSearchReq.json();

              if (fecSearchData.results && fecSearchData.results.length > 0) {
                const candidate = fecSearchData.results[0];

                if (candidate.principal_committees && candidate.principal_committees.length > 0) {
                  const committeeId = candidate.principal_committees[0].committee_id;

                  // Step 2: Fetch top donor employers for the current election cycle
                  const fecDonorUrl = `https://api.open.fec.gov/v1/committee/${committeeId}/schedules/schedule_a/by_employer/?api_key=${fecApiKey}&cycle=2024&sort=-total`;
                  const fecDonorReq = await fetch(fecDonorUrl);
                  const fecDonorData = await fecDonorReq.json();

                  if (fecDonorData.results && fecDonorData.results.length > 0) {
                    donorHtml = `<ul style="margin: 0; padding-left: 20px;">`;
                    
                    // Display top 5 donor employers/PACs
                    const topDonors = fecDonorData.results.slice(0, 5);
                    topDonors.forEach((donor) => {
                      const amountFormatted = new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0
                      }).format(donor.total);

                      donorHtml += `<li><strong>${donor.employer}</strong>: ${amountFormatted}</li>`;
                    });

                    donorHtml += `</ul>`;
                  } else {
                    donorHtml = `<p><em>No major PAC or corporate donor aggregations found for this cycle.</em></p>`;
                  }
                }
              }
            } catch (fecErr) {
              console.error(`FEC lookup failed for ${official.name}:`, fecErr);
              donorHtml = `<p><em>Unable to load FEC financial data right now.</em></p>`;
            }

            // --- C. Assemble Official's Full HTML Card ---
            representativesHtml += `
              <div class="rep-card" style="margin-bottom: 2.5rem; padding: 1.5rem; border: 1px solid #ccc; border-radius: 8px;">
                <h2 style="margin-top: 0;">${official.name} <span style="font-size: 1rem; color: #666;">(${official.party || "Unknown Party"})</span></h2>
                <h3 style="color: #444; margin-top: -0.5rem;">${officeTitle}</h3>
                
                <h4 style="margin-bottom: 0.5rem;">Target Local Offices:</h4>
                <div class="offices-grid">
                  ${addressesHtml}
                </div>
                
                <div class="donor-card" style="margin-top: 1.5rem; padding: 1rem; background: #fff8e6; border-left: 4px solid #f39c12; border-radius: 4px;">
                  <h4 style="margin-top: 0; margin-bottom: 0.5rem;">Top Financial Backers (2024 Cycle):</h4>
                  ${donorHtml}
                  <small style="display: block; margin-top: 10px; color: #777;">Source: OpenFEC (Federal Election Commission)</small>
                </div>
              </div>
            `;
          }
        }
      } else {
        representativesHtml = `<p>No federal lawmakers found for ZIP code <strong>${zip}</strong>.</p>`;
      }

      // 4. Inject the final HTML into index.html using HTMLRewriter
      return new HTMLRewriter()
        .on("#results-container", {
          element(el) {
            el.setInnerContent(
              `
              <h1 style="margin-bottom: 1.5rem;">Action Targets for ZIP: ${zip}</h1>
              ${representativesHtml}
              `,
              { html: true }
            );
          }
        })
        .transform(assetResponse);

    } catch (err) {
      console.error("Worker Execution Error:", err);
      return new HTMLRewriter()
        .on("#results-container", {
          element(el) {
            el.setInnerContent(
              `<p style="color: red; font-weight: bold;">Error retrieving location data. Please double-check your ZIP code and try again.</p>`,
              { html: true }
            );
          }
        })
        .transform(assetResponse);
    }
  }
};
