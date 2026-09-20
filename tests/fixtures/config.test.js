/* Test-only APP_CONFIG, served in place of the real config.js by
   tests/support/serve-static.js so the suite never talks to production
   Supabase/Airtable/Google Sheets - everything points at the local mock
   server started by each test file. */
window.APP_CONFIG = {
  supabaseUrl: "http://localhost:8211/fake-supabase",
  supabasePublishableKey: "fake-key-for-local-testing",
  sessionsCsvUrl: "data/Sessions.csv",
  coachesCsvUrl: "",
  venueInfoCsvUrl: "",
  calendarCsvUrl: "",
  changesCsvUrl: "http://localhost:8211/changes",
  termsCsvUrl: "",
  themesCsvUrl: "",
  contentApiUrl: "http://localhost:8211/hub-content",
  coachCodes: {}
};
