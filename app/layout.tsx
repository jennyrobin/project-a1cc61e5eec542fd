import type { Metadata } from "next";
import "./globals.css";

export const metadata:Metadata={title:"Wordway",description:"Adaptive AI vocabulary learning"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
