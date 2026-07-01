const nodemailer = require("nodemailer");
const supabase = require("../lib/supabase");

// ── Recipient(s) for testing — replace with alert_settings table once built ──
const TEST_RECIPIENTS = process.env.ALERT_TEST_RECIPIENTS
  ? process.env.ALERT_TEST_RECIPIENTS.split(",").map((e) => e.trim())
  : []; // fallback empty — must be set in .env, see note below

// ── Build transporter using existing Gmail SMTP creds ────────────────────────
function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Count + fetch new matches across all 4 tables ─────────────────────────────
async function getNewMatches() {
  const [trademark, domain, marketplace, social] = await Promise.all([
    supabase
      .from("trademark_matches")
      .select("registry, matched_keyword, filing_name, created_at")
      .eq("status", "new")
      .order("created_at", { ascending: false }),

    supabase
      .from("domain_matches")
      .select("keyword_matched, domain, created_at")
      .eq("status", "new")
      .order("created_at", { ascending: false }),

    supabase
      .from("marketplace_matches")
      .select("platform, keyword_matched, listing_title, created_at")
      .eq("status", "new")
      .order("created_at", { ascending: false }),

    supabase
      .from("social_matches")
      .select("platform, keyword_matched, handle_or_url, created_at")
      .eq("status", "new")
      .order("created_at", { ascending: false }),
  ]);

  const trademarkRows = (trademark.data || []).map((r) => ({
    source:     r.registry || "Trademark",
    keyword:    r.matched_keyword,
    match_name: r.filing_name,
    date_found: r.created_at,
  }));

  const domainRows = (domain.error ? [] : domain.data || []).map((r) => ({
    source:     "Domain",
    keyword:    r.keyword_matched,
    match_name: r.domain,
    date_found: r.created_at,
  }));

  const marketplaceRows = (marketplace.error ? [] : marketplace.data || []).map((r) => ({
    source:     r.platform || "Marketplace",
    keyword:    r.keyword_matched,
    match_name: r.listing_title,
    date_found: r.created_at,
  }));

  const socialRows = (social.error ? [] : social.data || []).map((r) => ({
    source:     r.platform || "Social",
    keyword:    r.keyword_matched,
    match_name: r.handle_or_url,
    date_found: r.created_at,
  }));

  return [...trademarkRows, ...domainRows, ...marketplaceRows, ...socialRows]
    .sort((a, b) => new Date(b.date_found) - new Date(a.date_found));
}

// ── Format a date nicely for the email body ───────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ── Build HTML email body ─────────────────────────────────────────────────────
function buildHtmlBody(matches) {
  const dashboardUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  const rows = matches
    .map(
      (m) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #EEEEEE;font-size:13px;">${escapeHtml(m.source || "—")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EEEEEE;font-size:13px;font-weight:600;color:#1B2A4A;">${escapeHtml(m.keyword || "—")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EEEEEE;font-size:13px;">${escapeHtml(m.match_name || "—")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #EEEEEE;font-size:13px;color:#777;">${formatDate(m.date_found)}</td>
      </tr>`
    )
    .join("");

  return `
  <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
    <h2 style="color:#1B2A4A;margin-bottom:4px;">Trademark Monitor — New Threats Found</h2>
    <p style="color:#555;font-size:14px;margin-top:0;">
      ${matches.length} new match${matches.length === 1 ? "" : "es"} detected across trademark registries, domains, marketplaces, and social platforms.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-top:16px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:10px 12px;background:#1B2A4A;color:#fff;font-size:12px;">Source</th>
          <th style="text-align:left;padding:10px 12px;background:#1B2A4A;color:#fff;font-size:12px;">Keyword</th>
          <th style="text-align:left;padding:10px 12px;background:#1B2A4A;color:#fff;font-size:12px;">Match Name</th>
          <th style="text-align:left;padding:10px 12px;background:#1B2A4A;color:#fff;font-size:12px;">Date Found</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <p style="margin-top:24px;">
      <a href="${dashboardUrl}" style="display:inline-block;padding:10px 20px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">
        View Full Dashboard
      </a>
    </p>
  </div>`;
}

// ── Escape HTML to prevent broken markup from weird match names ──────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── MAIN: call after a scan run ───────────────────────────────────────────────
async function sendAlertIfNewMatches() {
  console.log("[EmailAlert] Checking for new matches...");

  const matches = await getNewMatches();
  const count = matches.length;

  if (count === 0) {
    console.log("[EmailAlert] No new matches found. Skipping email.");
    return { sent: false, count: 0 };
  }

  if (TEST_RECIPIENTS.length === 0) {
    console.error("[EmailAlert] No recipients configured. Set ALERT_TEST_RECIPIENTS in .env (comma-separated).");
    return { sent: false, count, error: "No recipients configured" };
  }

  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const subject = `[Brand Monitor] ${count} new threat${count === 1 ? "" : "s"} found — ${today}`;
  const html = buildHtmlBody(matches);

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"Trademark Monitor" <${process.env.SMTP_USER}>`,
      to: TEST_RECIPIENTS.join(","),
      subject,
      html,
    });

    console.log(`[EmailAlert] Sent email to ${TEST_RECIPIENTS.join(", ")} — ${count} new match(es).`);
    return { sent: true, count };
  } catch (err) {
    console.error("[EmailAlert] Failed to send email:", err.message);
    return { sent: false, count, error: err.message };
  }
}

module.exports = { sendAlertIfNewMatches };