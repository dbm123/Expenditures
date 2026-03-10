import { google } from "googleapis";

const FOLDER_ID = "1ptFEba07MnEdwnMUN8OnEm-7K_m5KXBJ";

async function check() {
  try {
    require("dotenv").config({ path: ".env.local" });
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON as string);
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });

    const drive = google.drive({ version: "v3", auth });
    const about = await drive.about.get({ fields: "storageQuota, user" });
    console.log("Service Account Info:", JSON.stringify(about.data, null, 2));
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

check();
