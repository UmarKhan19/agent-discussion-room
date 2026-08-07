import type { Metadata, Viewport } from "next";

/**
 * Product identity metadata for the Agent Discussion Room. Kept in its own
 * module so the metadata contract is testable without pulling in font and
 * stylesheet side effects. themeColor values mirror the --background token
 * from globals.css (the theme test asserts they stay in sync).
 */
export const metadata: Metadata = {
  applicationName: "Agent Discussion Room",
  title: "Agent Discussion Room",
  description:
    "Watch a bounded, moderated debate between a Supporter and an Opponent in the Agent Discussion Room.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};
