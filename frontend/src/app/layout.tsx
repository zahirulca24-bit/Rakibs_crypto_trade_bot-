import type { Metadata } from "next";
import Sidebar from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rakib Crypto Trade",
  description: "Crypto trading dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="appShell">
          <Sidebar />
          <main className="mainContent">{children}</main>
        </div>
      </body>
    </html>
  );
}
