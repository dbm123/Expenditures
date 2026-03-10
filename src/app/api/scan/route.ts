import { NextResponse } from "next/server";
import { google } from "googleapis";
import { parse } from "csv-parse/sync";

// The Google Drive folder ID provided by the user
const FOLDER_ID = "1ptFEba07MnEdwnMUN8OnEm-7K_m5KXBJ";

export async function POST() {
  try {
    // 1. Check for required environment variables
    let clientEmail = "";
    let privateKey = "";

    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      try {
        const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        clientEmail = creds.client_email;
        privateKey = creds.private_key;
      } catch (e) {
        return NextResponse.json(
          { message: "Failed to parse GOOGLE_CREDENTIALS_JSON. Please ensure it is valid JSON." },
          { status: 500 }
        );
      }
    } else {
      clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
      privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
    }

    if (!clientEmail || !privateKey) {
      return NextResponse.json(
        { message: "Missing Google Service Account credentials in .env.local" },
        { status: 500 }
      );
    }

    // Robustly formatting the private key
    // Remove wrapping quotes, spaces, and trailing commas
    privateKey = privateKey.replace(/^["', ]+|["', ]+$/g, '');
    
    // Ensure actual newlines are used instead of literal '\n'
    privateKey = privateKey.replace(/\\n/g, "\n");
    
    // If newlines were lost entirely, try to restore the standard format headers
    privateKey = privateKey.replace(/-----BEGIN PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----\n");
    privateKey = privateKey.replace(/-----END PRIVATE KEY-----/g, "\n-----END PRIVATE KEY-----");
    privateKey = privateKey.replace(/\n+/g, "\n"); // clean up double newlines

    // 2. Initialize Google Auth client
    const auth = new google.auth.JWT({
      email: clientEmail.replace(/^["', ]+|["', ]+$/g, ''),
      key: privateKey,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });

    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    // 3. List all files in the specific Wealthsimple folder
    const fileListResponse = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
      fields: "files(id, name)",
    });

    const files = fileListResponse.data.files;
    if (!files || files.length === 0) {
      return NextResponse.json({ message: "No CSV files found in the specified folder." }, { status: 404 });
    }

    // Array to hold all processed rows
    const allRows: any[] = [];
    
    // Aggregation maps
    const summaryMap: Record<string, { deposits: number; expenditures: number; maxDate: Date; endingBalance: number }> = {};

    // 4. Download and parse each CSV file
    for (const file of files) {
      const { id, name } = file;
      if (!id || !name) continue;

      const fileRes = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "text" });
      const csvData = fileRes.data;

      // Parse the CSV
      const records = parse(csvData as string, {
        columns: true,
        skip_empty_lines: true,
      });

      const hasWK = name.includes("WK");

      for (const record of records as any[]) {
        // Find correct keys depending on exact headers in Wealthsimple CSVs
        // Usually headers are Date, Description, Amount, Balance
        const dateRaw = record.Date || record.date;
        const description = record.Description || record.description || record.Name || record.name;
        const amountStr = record.Amount || record.amount;
        const balanceStr = record.Balance || record.balance || "0";

        if (!dateRaw) continue; // skip invalid rows

        // Safely parse numbers, removing $ or commas
        const cleanNumber = (val: string) => parseFloat(val.replace(/[$,]/g, '')) || 0;
        
        const amount = cleanNumber(amountStr);
        const balance = cleanNumber(balanceStr);
        const dateObj = new Date(dateRaw);

        // Fill Data
        let transaction = "";
        let uniqueId = "";

        if (hasWK) {
          // "Transaction - Data from file with “WK” in the name will have a “Transaction” field so put the Transaction field data in here"
          transaction = record.Transaction || `T-${dateRaw}`;
        } else {
          // "Unique ID - Data from files without “WK” in the name will have a “Unique ID” field so put the “Unique ID” field data in here"
          uniqueId = record["Unique ID"] || record.unique_id || `ID-${dateRaw}`;
        }

        allRows.push({
          dateObj,
          Date: dateRaw,
          Description: description || "",
          Amount: amount,
          Balance: balance,
          Transaction: transaction,
          UniqueID: uniqueId,
          Notes: "",
        });

        // Track Monthly Summary Statistics
        // E.g., Date comes in as YYYY-MM-DD
        const monthYear = dateObj.toLocaleString("en-US", { month: "short", year: "numeric" }); // e.g., "Jan 2024"

        if (!summaryMap[monthYear]) {
          summaryMap[monthYear] = { deposits: 0, expenditures: 0, maxDate: new Date(0), endingBalance: 0 };
        }

        if (amount > 0) {
          summaryMap[monthYear].deposits += amount;
        } else {
          // Expenditures should probably be recorded as a positive absolute number or left negative
          summaryMap[monthYear].expenditures += amount;
        }

        // Keep track of the balance on the most recent date of that month
        if (dateObj > summaryMap[monthYear].maxDate) {
          summaryMap[monthYear].maxDate = dateObj;
          summaryMap[monthYear].endingBalance = balance;
        }
      }
    }

    // 5. Sort the consolidated data by Date (ascending)
    allRows.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

    // Prepare Sheet Data
    const sheetData = [
      ["Date", "Description", "Amount", "Balance", "Transaction", "Unique ID", "Notes"]
    ];

    allRows.forEach(row => {
      sheetData.push([
        row.Date, 
        row.Description, 
        row.Amount, 
        row.Balance, 
        row.Transaction, 
        row.UniqueID, 
        row.Notes
      ]);
    });

    // 6. Create Google Sheet and save inside the target folder
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mmm = now.toLocaleString('en-US', { month: 'short' });
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    
    const spreadsheetId = "1Dr-LCGAyZFcjwJPjhnaPxD1kgRtCyl6eswybFtmiP1Y";

    // 6. Output data to the existing sheet
    // First, clear any old data that was in there
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Sheet1', // Assuming the first tab is named Sheet1
    });

    // Write the fresh scan data
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: sheetData,
      },
    });

    // 7. Format the summary response for the frontend table
    const summaryKeys = Object.keys(summaryMap).sort((a, b) => {
      return new Date(a).getTime() - new Date(b).getTime();
    });

    const summaryResult = summaryKeys.map(key => ({
      month: key,
      deposits: summaryMap[key].deposits,
      expenditures: Math.abs(summaryMap[key].expenditures),
      balance: summaryMap[key].endingBalance,
      notes: ""
    }));

    return NextResponse.json({ 
      success: true, 
      summary: summaryResult,
      spreadsheetId 
    });

  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
