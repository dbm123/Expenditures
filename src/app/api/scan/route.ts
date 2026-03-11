import { NextResponse } from "next/server";
import { google } from "googleapis";
import { parse } from "csv-parse/sync";
import * as fs from "fs";
import * as path from "path";

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
        
        // Format date as DD-MMM-YYYY (e.g. 10-Mar-2026)
        const day = String(dateObj.getDate()).padStart(2, '0');
        const month = dateObj.toLocaleString('en-US', { month: 'short' });
        const year = dateObj.getFullYear();
        const formattedDate = `${day}-${month}-${year}`;

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

        const rawRowText = Object.values(record).join(" ").toLowerCase();

        allRows.push({
          dateObj,
          Date: formattedDate,
          Description: description || "",
          Amount: amount,
          Balance: balance,
          Transaction: transaction,
          UniqueID: uniqueId,
          Notes: "",
          Account: name.replace(/\.csv$/i, ''),
          RawText: rawRowText,
        });

        // (Summary map logic removed from this stage; will calculate from filtered data later)
      }
    }

    // 5. Sort the consolidated data by Date (ascending)
    allRows.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

    // Read Exclusions.txt
    const exclusionsPath = path.join(process.cwd(), 'Exclusions.txt');
    let exclusions: string[] = [];
    if (fs.existsSync(exclusionsPath)) {
      exclusions = fs.readFileSync(exclusionsPath, 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
    }

    // Prepare Sheet Data
    const sheetData = [
      ["Date", "Description", "Amount", "Balance", "Transaction", "Unique ID", "Notes"]
    ];

    const processedSummaryMap: Record<string, number> = {};

    allRows.forEach(row => {
      // Only show negative Amount values; skip the rest
      if (row.Amount >= 0) return;

      const rowStr = row.RawText || "";
      
      const isExcluded = exclusions.some(ex => rowStr.includes(ex));
      if (isExcluded) return;

      const my = row.dateObj.toLocaleString("en-US", { month: "short", year: "numeric" });
      if (!processedSummaryMap[my]) processedSummaryMap[my] = 0;
      processedSummaryMap[my] += row.Amount;

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

    const mainInfo = await sheets.spreadsheets.get({ spreadsheetId });
    const mainSheetName = mainInfo.data.sheets?.[0]?.properties?.title || 'Sheet1';
    const mainSheetId = mainInfo.data.sheets?.[0]?.properties?.sheetId || 0;

    // 6. Output data to the existing sheet
    // First, clear any old data that was in there
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: mainSheetName, 
    });

    // Write the fresh scan data
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${mainSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: sheetData,
      },
    });

    // Format the first sheet
    const mainFormatRequests: any[] = [];
    
    // Clear existing background colors
    mainFormatRequests.push({
      repeatCell: {
        range: { sheetId: mainSheetId },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor'
      }
    });

    // Make the header (first row) bold
    mainFormatRequests.push({
      repeatCell: {
        range: {
          sheetId: mainSheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 7
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat.textFormat.bold'
      }
    });

    // Freeze the first row
    mainFormatRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: mainSheetId,
          gridProperties: { frozenRowCount: 1 }
        },
        fields: 'gridProperties.frozenRowCount'
      }
    });



    // Hide Column D (Balance)
    mainFormatRequests.push({
      updateDimensionProperties: {
        range: {
          sheetId: mainSheetId,
          dimension: 'COLUMNS',
          startIndex: 3,
          endIndex: 4
        },
        properties: {
          hiddenByUser: true
        },
        fields: 'hiddenByUser'
      }
    });

    if (mainFormatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: mainFormatRequests
        }
      });
    }

    // 7. Format the summary response for the frontend table
    const summaryKeys = Object.keys(processedSummaryMap).sort((a, b) => {
      return new Date(a).getTime() - new Date(b).getTime();
    });

    const summaryResult = summaryKeys.map(key => ({
      month: key,
      expenditures: Math.abs(processedSummaryMap[key]),
      notes: ""
    }));

    // 8. Output summary data to the second sheet
    const summarySpreadsheetId = "16_iqdL2OzK06aj374OsFGzFmMytQthNRL5tdqQWymEM";
    const summarySheetData: any[][] = [
      ["Month", "Expenditures"]
    ];

    summaryResult.forEach(row => {
      summarySheetData.push([
        row.month,
        row.expenditures
      ]);
    });

    const summaryInfo = await sheets.spreadsheets.get({ spreadsheetId: summarySpreadsheetId });
    const summarySheetName = summaryInfo.data.sheets?.[0]?.properties?.title || 'Sheet1';

    await sheets.spreadsheets.values.clear({
      spreadsheetId: summarySpreadsheetId,
      range: `${summarySheetName}!A:B`, // Only clear columns A and B to preserve user-added columns
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: summarySpreadsheetId,
      range: `${summarySheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: summarySheetData,
      },
    });

    const summarySheetId = summaryInfo.data.sheets?.[0]?.properties?.sheetId || 0;
    const summaryFormatRequests: any[] = [];
    
    // Make the header (first row) bold
    summaryFormatRequests.push({
      repeatCell: {
        range: {
          sheetId: summarySheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 2
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat.textFormat.bold'
      }
    });

    // Freeze the first row
    summaryFormatRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: summarySheetId,
          gridProperties: { frozenRowCount: 1 }
        },
        fields: 'gridProperties.frozenRowCount'
      }
    });

    if (summaryFormatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: summarySpreadsheetId,
        requestBody: {
          requests: summaryFormatRequests
        }
      });
    }

    // 9. Output to the Third Sheet: Opening and Closing Balances per Account
    const thirdSpreadsheetId = "1KKKiArFwAVXP9zTpHhJWO4gqz4pAnfosfcaCoQA-NhQ";
    const thirdSheetData: any[][] = [
      ["Month/Year", "Account", "Opening Balance", "Closing Balance", "Expenditure", "Notes"]
    ];

    const accountMonthGroups: Record<string, Record<string, any[]>> = {};

    for (const row of allRows) {
        const monthPart = row.dateObj.toLocaleString("en-US", { month: "short" });
        const yearPart = row.dateObj.getFullYear();
        const monthYear = `${monthPart}-${yearPart}`;

        if (!accountMonthGroups[monthYear]) {
            accountMonthGroups[monthYear] = {};
        }
        if (!accountMonthGroups[monthYear][row.Account]) {
            accountMonthGroups[monthYear][row.Account] = [];
        }
        accountMonthGroups[monthYear][row.Account].push(row);
    }

    const uniqueMonthYears = Object.keys(accountMonthGroups).sort((a, b) => {
        const dA = new Date(`01 ${a}`);
        const dB = new Date(`01 ${b}`);
        return dA.getTime() - dB.getTime();
    });

    for (const my of uniqueMonthYears) {
        let totalMonthlyExpenditure = 0;
        const accountsInMonth = Object.keys(accountMonthGroups[my]).sort();

        for (const acc of accountsInMonth) {
            const rows = accountMonthGroups[my][acc];
            const firstRow = rows[0];
            const lastRow = rows[rows.length - 1];

            const openingBalance = Number((firstRow.Balance - firstRow.Amount).toFixed(2));
            const closingBalance = Number(lastRow.Balance.toFixed(2));
            
            // Calculate expenditure by summing all negative transactions
            let sumNegative = 0;
            for (const r of rows) {
                if (r.Amount < 0) {
                    sumNegative += r.Amount;
                }
            }
            const expenditure = Number(Math.abs(sumNegative).toFixed(2));

            totalMonthlyExpenditure += expenditure;

            thirdSheetData.push([
                my,
                acc,
                openingBalance,
                closingBalance,
                expenditure,
                ""
            ]);
        }

        thirdSheetData.push([
            my,
            "Total Expenditure",
            "",
            "",
            Number(totalMonthlyExpenditure.toFixed(2)),
            ""
        ]);
    }

    const thirdInfo = await sheets.spreadsheets.get({ spreadsheetId: thirdSpreadsheetId });
    const thirdSheetName = thirdInfo.data.sheets?.[0]?.properties?.title || 'Sheet1';
    const thirdSheetId = thirdInfo.data.sheets?.[0]?.properties?.sheetId || 0;

    await sheets.spreadsheets.values.clear({
      spreadsheetId: thirdSpreadsheetId,
      range: thirdSheetName,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: thirdSpreadsheetId,
      range: `${thirdSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: thirdSheetData,
      },
    });

    // 10. Format the Third Sheet with alternating monthly background colors
    const formatRequests: any[] = [];
    
    // Clear all existing background colors first
    formatRequests.push({
      repeatCell: {
        range: { sheetId: thirdSheetId },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor'
      }
    });

    // Make the header (first row) bold
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: thirdSheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 6
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat.textFormat.bold'
      }
    });

    // Freeze the first row
    formatRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: thirdSheetId,
          gridProperties: { frozenRowCount: 1 }
        },
        fields: 'gridProperties.frozenRowCount'
      }
    });

    let currentRowIndex = 1; // Row 0 is the header
    let applyBlue = false; // Alternate starts with no shading, then light blue

    for (const my of uniqueMonthYears) {
      const numRows = Object.keys(accountMonthGroups[my]).length + 1; // Accounts + Total Expenditure row

      if (applyBlue) {
        // Highlight the account rows in light blue, leaving the total row for the red highlight
        formatRequests.push({
          repeatCell: {
            range: {
              sheetId: thirdSheetId,
              startRowIndex: currentRowIndex,
              endRowIndex: currentRowIndex + numRows - 1,
              startColumnIndex: 0,
              endColumnIndex: 6
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.89, green: 0.95, blue: 0.99 } // Light blue
              }
            },
            fields: 'userEnteredFormat.backgroundColor'
          }
        });
      }

      // Always highlight the "Total Expenditure" line for this month in light red
      formatRequests.push({
        repeatCell: {
          range: {
            sheetId: thirdSheetId,
            startRowIndex: currentRowIndex + numRows - 1,
            endRowIndex: currentRowIndex + numRows,
            startColumnIndex: 0,
            endColumnIndex: 6
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.98, green: 0.89, blue: 0.89 } // Light red
            }
          },
          fields: 'userEnteredFormat.backgroundColor'
        }
      });

      currentRowIndex += numRows;
      applyBlue = !applyBlue;
    }

    if (formatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: thirdSpreadsheetId,
        requestBody: {
          requests: formatRequests
        }
      });
    }

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
