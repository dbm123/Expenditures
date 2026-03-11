"use client";

import { useState } from "react";

type MonthlySummary = {
  month: string;
  expenditures: number;
  notes: string;
};

export default function Home() {
  const [isScanning, setIsScanning] = useState(false);
  const [summaryData, setSummaryData] = useState<MonthlySummary[]>([]);
  const [statusMessage, setStatusMessage] = useState("");

  const handleScan = async () => {
    setIsScanning(true);
    setStatusMessage("Scanning Google Drive directory...");
    
    try {
      const response = await fetch("/api/scan", { method: "POST" });
      const data = await response.json();

      if (response.ok) {
        setSummaryData(data.summary || []);
        setStatusMessage("COMPLETE");
      } else {
        setStatusMessage(`Error: ${data.message || "Failed to parse files"}`);
      }
    } catch (error) {
      console.error(error);
      setStatusMessage("An unexpected error occurred.");
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <main className="dashboard-container">
      <div className="header">
        <h1>Monthly Expenditures Dashboard</h1>
        <p>Sync your Wealthsimple statements and aggregate data</p>
      </div>

      <div className="scan-section">
        <button 
          onClick={handleScan}
          disabled={isScanning}
          className={`scan-btn ${isScanning ? "scanning" : ""}`}
        >
          {isScanning ? "Scanning..." : "Scan"}
        </button>

        <div className={`loader ${isScanning ? "active" : ""}`}>
          <div className="dot"></div>
          <div className="dot"></div>
          <div className="dot"></div>
        </div>
      </div>

      <div>
        <h2 className="summary-title">Summary</h2>
        
        {summaryData.length > 0 ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Expenditures</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {summaryData.map((row, index) => (
                  <tr key={index}>
                    <td>{row.month}</td>
                    <td>${row.expenditures.toFixed(2)}</td>
                    <td>{row.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="status-message">
            {isScanning ? "Waiting for results..." : "No data available. Click Scan to process statements."}
          </p>
        )}
      </div>

      {statusMessage && !isScanning && (
        <p className="status-message" style={{ marginTop: '2rem', color: statusMessage.includes('Error') ? 'var(--btn-red)' : 'var(--text-main)' }}>
          {statusMessage === 'COMPLETE' ? (
            <a 
              href="https://docs.google.com/spreadsheets/d/16_iqdL2OzK06aj374OsFGzFmMytQthNRL5tdqQWymEM/edit?usp=sharing" 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ color: 'var(--accent-color)', textDecoration: 'underline' }}
            >
              Monthly Expenditures Summary
            </a>
          ) : (
            statusMessage
          )}
        </p>
      )}
    </main>
  );
}
