require("dotenv").config();
const { sendAlertIfNewMatches } = require("./services/emailAlert");

sendAlertIfNewMatches()
  .then((result) => { console.log("Result:", result); process.exit(0); })
  .catch((err) => { console.error("Error:", err); process.exit(1); });