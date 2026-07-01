const express  = require("express");
const router   = express.Router();
const supabase = require("../lib/supabase");

// We store a single settings row — always upsert the same fixed ID so there's
// only ever one row in alert_settings (no per-user auth needed for this build).
const SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

// GET /api/settings
// Returns current alert settings (email + alert_enabled)
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("alert_settings")
      .select("email, alert_enabled, last_alerted_at")
      .eq("id", SETTINGS_ID)
      .maybeSingle();

    if (error) throw new Error(error.message);

    // Return defaults if no row exists yet
    res.json(data || { email: "", alert_enabled: true, last_alerted_at: null });
  } catch (err) {
    console.error("[GET /api/settings] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings
// Upserts email + alert_enabled into alert_settings
router.post("/", async (req, res) => {
  const { email, alerts_enabled } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required" });
  }

  try {
    const { data, error } = await supabase
      .from("alert_settings")
      .upsert(
        {
          id:            SETTINGS_ID,
          email:         email.trim(),
          alert_enabled: alerts_enabled ?? true,
        },
        { onConflict: "id" }
      )
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error("[POST /api/settings] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;