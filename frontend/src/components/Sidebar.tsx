"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { label: "Dashboard", href: "/", icon: "◫" },
  { label: "Market Watch", href: "/market-watch", icon: "⌁" },
  { label: "Scanner", href: "/scanner", icon: "◎" },
  { label: "Engine Working Log", href: "/engine-working-log", icon: "≋" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <style>{`@media(max-width:760px){.navList{grid-template-columns:repeat(4,minmax(0,1fr))}}`}</style>
      <div className="brand">
        <div className="brandMark">R</div>
        <div>
          <strong>Rakib Trade</strong>
          <span>Crypto Terminal</span>
        </div>
      </div>

      <nav className="navList">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link key={item.href} href={item.href} className={`navItem ${active ? "active" : ""}`}>
              <span className="navIcon">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebarFooter">
        <div className="statusDot" />
        <div>
          <strong>System ready</strong>
          <span>Frontend preview</span>
        </div>
      </div>
    </aside>
  );
}
