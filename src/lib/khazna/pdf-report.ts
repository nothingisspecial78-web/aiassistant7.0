import { formatDate, formatINR, TODAY } from "./format";
import type {
  InstitutionProfile,
  ReportExport,
  Signatory,
  SignatureSlotConfig,
  Student,
  Tx,
} from "./types";

function fmtPdfInr(n: number): string {
  const rounded = Math.round(Number(n) || 0);
  const abs = Math.abs(rounded).toLocaleString("en-IN");
  return rounded < 0 ? `-Rs. ${abs}` : `Rs. ${abs}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const fontCache = new Map<string, string | null>();

async function fetchFontBase64(url: string): Promise<string | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  if (fontCache.has(url)) return fontCache.get(url) ?? null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      fontCache.set(url, null);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const b64 = uint8ToBase64(buf);
    fontCache.set(url, b64);
    return b64;
  } catch {
    fontCache.set(url, null);
    return null;
  }
}

async function registerUnicodeFonts(doc: {
  addFileToVFS: (filename: string, data: string) => void;
  addFont: (postScriptName: string, id: string, fontStyle: string) => void;
}): Promise<string> {
  const [regular, bold, malayalam] = await Promise.all([
    fetchFontBase64("/fonts/NotoSans-Regular.ttf"),
    fetchFontBase64("/fonts/NotoSans-Bold.ttf"),
    fetchFontBase64("/fonts/NotoSansMalayalam-Regular.ttf"),
  ]);

  if (regular) {
    doc.addFileToVFS("NotoSans-Regular.ttf", regular);
    doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  }
  if (bold) {
    doc.addFileToVFS("NotoSans-Bold.ttf", bold);
    doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  } else if (regular) {
    doc.addFont("NotoSans-Regular.ttf", "NotoSans", "bold");
  }
  if (malayalam) {
    doc.addFileToVFS("NotoSansMalayalam-Regular.ttf", malayalam);
    doc.addFont("NotoSansMalayalam-Regular.ttf", "NotoSansMalayalam", "normal");
  }
  return regular ? "NotoSans" : "helvetica";
}

async function loadImageAsDataUrl(
  src?: string | null
): Promise<{ dataUrl: string; format: "PNG" | "JPEG" } | null> {
  if (!src || typeof window === "undefined") return null;
  if (src.startsWith("data:image/")) {
    const format = src.includes("image/jpeg") || src.includes("image/jpg") ? "JPEG" : "PNG";
    return { dataUrl: src, format };
  }
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const blob = await res.blob();
    const format = blob.type.includes("jpeg") || blob.type.includes("jpg") ? "JPEG" : "PNG";
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    return dataUrl ? { dataUrl, format } : null;
  } catch {
    return null;
  }
}

function addPageNumbers(
  doc: {
    getNumberOfPages: () => number;
    setPage: (p: number) => void;
    setFont: (fontName: string, fontStyle?: string) => void;
    setFontSize: (size: number) => void;
    setTextColor: (r: number, g: number, b: number) => void;
    text: (text: string, x: number, y: number, opts?: { align?: "left" | "center" | "right" }) => void;
  },
  fontFamily: string,
  pageWidth: number,
  pageHeight: number
) {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont(fontFamily, "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Page ${i} of ${total}`, pageWidth - 14, pageHeight - 8, { align: "right" });
  }
}

export async function generateStudentStatementPdf(opts: {
  collegeName: string;
  student: Student;
  transactions: Tx[];
  sectorMap?: Map<string, string> | undefined;
  generatedBy?: string | undefined;
  institutionProfile?: InstitutionProfile | undefined;
}): Promise<string> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableMod.default;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const fontFamily = await registerUnicodeFonts(doc);

  const instName = opts.institutionProfile?.name || opts.collegeName || "Islahul Uloom";
  doc.setFillColor(249, 115, 22);
  doc.rect(0, 0, 210, 4, "F");

  const logo = await loadImageAsDataUrl(opts.institutionProfile?.logo_path);
  const textX = logo ? 30 : 14;
  if (logo) {
    try {
      doc.addImage(logo.dataUrl, logo.format, 14, 9, 13, 13);
    } catch {
      // ignore invalid image
    }
  }

  doc.setFont(fontFamily, "bold");
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(instName, textX, 16);

  doc.setFont(fontFamily, "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    opts.institutionProfile?.tagline || "Official Student Ledger Statement",
    textX,
    22
  );

  doc.setFont(fontFamily, "bold");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(`Student Statement: ${opts.student.name} (${opts.student.id})`, 14, 32);

  doc.setFont(fontFamily, "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Class: ${opts.student.className} · Guardian: ${opts.student.guardian || "—"} · Generated: ${formatDate(TODAY)}`,
    14,
    38
  );

  const activeTxs = opts.transactions.filter((t) => !t.voided);
  let credit = 0;
  let debit = 0;
  for (const t of activeTxs) {
    if (t.type === "credit") credit += t.amount;
    else debit += t.amount;
  }

  doc.setFillColor(248, 250, 252);
  doc.roundedRect(14, 43, 182, 16, 2, 2, "F");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Total Credit: ${fmtPdfInr(credit)}`, 18, 53);
  doc.text(`Total Debit: ${fmtPdfInr(debit)}`, 82, 53);
  doc.setFont(fontFamily, "bold");
  doc.setTextColor(15, 23, 42);
  doc.text(`Net Balance: ${fmtPdfInr(credit - debit)}`, 144, 53);

  autoTable(doc, {
    startY: 64,
    head: [["Date", "Receipt", "Sector", "Description", "Type", "Amount"]],
    body: activeTxs.map((t) => [
      formatDate(t.date),
      t.receiptNo,
      opts.sectorMap?.get(t.sector) || t.sector,
      t.title,
      t.type.toUpperCase(),
      fmtPdfInr(t.amount),
    ]),
    styles: { font: fontFamily, fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
  });

  addPageNumbers(doc, fontFamily, 210, 297);

  const filename = `Statement_${opts.student.id}_${opts.student.name.replace(/\s+/g, "_")}.pdf`;
  doc.save(filename);
  return filename;
}

export interface ClassReportPdfItem {
  studentId: string;
  studentName: string;
  className: string;
  credit: number;
  debit: number;
  balance: number;
}

export async function generateClassWisePdf(opts: {
  orgId?: string | undefined;
  collegeName: string;
  sectorName: string;
  sectorId?: string | undefined;
  className: string;
  from: string;
  to: string;
  contentFilter?: "all" | "credit" | "debit" | undefined;
  sortBy?: "adm_asc" | "adm_desc" | "name_asc" | "name_desc" | "bal_desc" | "bal_asc" | undefined;
  showSummaryCards?: boolean | undefined;
  showNetBalance?: boolean | undefined;
  showSignatureLines?: boolean | undefined;
  showPageNumbers?: boolean | undefined;
  orientation?: "portrait" | "landscape" | undefined;
  generatedBy?: string | undefined;
  institutionProfile?: InstitutionProfile | undefined;
  signatories?: Signatory[] | undefined;
  signatureSlots?: SignatureSlotConfig | undefined;
  qrVerification?: boolean | undefined;
  existingReports?: ReportExport[] | undefined;
  onExportRecorded?: ((exp: ReportExport) => void) | undefined;
  items: ClassReportPdfItem[];
}): Promise<string> {
  const [{ jsPDF }, autoTableMod, QRCode] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
    import("qrcode"),
  ]);
  const autoTable = autoTableMod.default;
  const orientation = opts.orientation || "portrait";
  const doc = new jsPDF({ orientation, unit: "mm", format: "a4" });
  const pageWidth = orientation === "landscape" ? 297 : 210;
  const pageHeight = orientation === "landscape" ? 210 : 297;
  const fontFamily = await registerUnicodeFonts(doc);

  const sorted = [...opts.items];
  const sortBy = opts.sortBy || "adm_asc";
  sorted.sort((a, b) => {
    if (sortBy === "adm_desc") return b.studentId.localeCompare(a.studentId);
    if (sortBy === "name_asc") return a.studentName.localeCompare(b.studentName);
    if (sortBy === "name_desc") return b.studentName.localeCompare(a.studentName);
    if (sortBy === "bal_desc") return b.balance - a.balance;
    if (sortBy === "bal_asc") return a.balance - b.balance;
    return a.studentId.localeCompare(b.studentId);
  });

  const totalCredit = sorted.reduce((acc, r) => acc + r.credit, 0);
  const totalDebit = sorted.reduce((acc, r) => acc + r.debit, 0);
  const netBalance = totalCredit - totalDebit;

  const ref = `KZ-RPT-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const token = `${ref}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  doc.setFillColor(249, 115, 22);
  doc.rect(0, 0, pageWidth, 4, "F");

  const [logo, seal] = await Promise.all([
    loadImageAsDataUrl(opts.institutionProfile?.logo_path),
    loadImageAsDataUrl(opts.institutionProfile?.seal_path),
  ]);
  const headerTextX = logo ? 30 : 14;
  if (logo) {
    try {
      doc.addImage(logo.dataUrl, logo.format, 14, 9, 13, 13);
    } catch {
      // ignore invalid logo
    }
  }

  const instName = opts.institutionProfile?.name || opts.collegeName || "Islahul Uloom";
  doc.setFont(fontFamily, "bold");
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(instName, headerTextX, 16);

  doc.setFont(fontFamily, "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `${opts.sectorName} · Class: ${opts.className} · Period: ${formatDate(opts.from)} to ${formatDate(opts.to)}`,
    headerTextX,
    22
  );
  doc.text(
    `Ref: ${ref} · Issued by ${opts.generatedBy || "Khazna"} on ${formatDate(TODAY)}`,
    headerTextX,
    27
  );

  if (opts.qrVerification !== false && typeof window !== "undefined") {
    try {
      const verifyUrl = `${window.location.origin}/v/${token}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 96, margin: 1 });
      doc.addImage(qrDataUrl, "PNG", pageWidth - 34, 8, 20, 20);
    } catch {
      // ignore QR draw failure in constrained environments
    }
  }

  let startY = 35;
  if (opts.showSummaryCards !== false) {
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(14, startY, pageWidth - 28, 14, 2, 2, "F");
    doc.setFont(fontFamily, "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text(`Students: ${sorted.length}`, 18, startY + 9);
    doc.text(`Total Credit: ${fmtPdfInr(totalCredit)}`, 55, startY + 9);
    doc.text(`Total Debit: ${fmtPdfInr(totalDebit)}`, 110, startY + 9);
    doc.setFont(fontFamily, "bold");
    doc.setTextColor(15, 23, 42);
    doc.text(`Net: ${fmtPdfInr(netBalance)}`, pageWidth - 52, startY + 9);
    startY += 19;
  }

  const includeCredit = opts.contentFilter !== "debit";
  const includeDebit = opts.contentFilter !== "credit";
  const includeBal = opts.showNetBalance !== false;

  const headRow = ["Ad.No", "Student Name", "Class"];
  if (includeCredit) headRow.push("Credit");
  if (includeDebit) headRow.push("Debit");
  if (includeBal) headRow.push("Balance");

  const bodyRows = sorted.map((r) => {
    const cols = [r.studentId, r.studentName, r.className];
    if (includeCredit) cols.push(fmtPdfInr(r.credit));
    if (includeDebit) cols.push(fmtPdfInr(r.debit));
    if (includeBal) cols.push(fmtPdfInr(r.balance));
    return cols;
  });

  autoTable(doc, {
    startY,
    head: [headRow],
    body: bodyRows,
    styles: { font: fontFamily, fontSize: 8.5, cellPadding: 2.3 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
  });

  if (opts.showSignatureLines !== false) {
    const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? startY + 20;
    let sigY = finalY + 14;
    if (sigY + 32 > pageHeight - 14) {
      doc.addPage();
      sigY = 24;
    }

    const slots = opts.signatureSlots
      ? [opts.signatureSlots.slot1, opts.signatureSlots.slot2, opts.signatureSlots.slot3]
      : [
          { label: "Prepared by", role: "accounts_officer" },
          { label: "Verified by (HOD)", role: "hod" },
          { label: "Approved by (Principal)", role: "principal" },
        ];

    const colWidth = (pageWidth - 28) / slots.length;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const x = 14 + i * colWidth;
      const activeSig =
        opts.signatories?.find(
          (s) =>
            s.active &&
            s.role === slot.role &&
            (!opts.sectorId || !s.sector_id || s.sector_id === opts.sectorId)
        ) || opts.signatories?.find((s) => s.active && s.role === slot.role);

      if (activeSig?.signature_path) {
        const sigImg = await loadImageAsDataUrl(activeSig.signature_path);
        if (sigImg) {
          try {
            doc.addImage(sigImg.dataUrl, sigImg.format, x + 2, sigY, 28, 10);
          } catch {
            // ignore invalid signature image
          }
        }
      }

      doc.setDrawColor(148, 163, 184);
      doc.line(x + 2, sigY + 13, x + colWidth - 10, sigY + 13);
      doc.setFont(fontFamily, "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text(activeSig?.full_name || slot.label, x + 2, sigY + 18);
      doc.setFont(fontFamily, "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(activeSig ? `${slot.label} · ${activeSig.designation}` : slot.label, x + 2, sigY + 22);
    }

    if (seal) {
      try {
        doc.addImage(seal.dataUrl, seal.format, pageWidth - 36, sigY - 2, 18, 18);
      } catch {
        // ignore invalid seal image
      }
    }
  }

  if (opts.showPageNumbers !== false) {
    addPageNumbers(doc, fontFamily, pageWidth, pageHeight);
  }

  const cleanSector = opts.sectorName.replace(/\s+/g, "");
  const cleanClass = opts.className.replace(/\s+/g, "");
  const filename = `Khazna_${cleanSector}_${cleanClass}_${opts.from}_${opts.to}.pdf`;

  if (opts.onExportRecorded) {
    const pdfBase64 = doc.output("datauristring");
    const expiry = opts.institutionProfile?.verify_expiry;
    const expiresAt =
      expiry === "90d"
        ? new Date(Date.now() + 90 * 86_400_000).toISOString()
        : expiry === "1y"
          ? new Date(Date.now() + 365 * 86_400_000).toISOString()
          : undefined;
    opts.onExportRecorded({
      id: `REP_${Date.now().toString(36).toUpperCase()}`,
      ref,
      token,
      org_id: opts.orgId || "demo",
      sector_id: opts.sectorId || cleanSector.toLowerCase(),
      sector_name: opts.sectorName,
      class_name: opts.className,
      mode: "class_report",
      date_from: opts.from,
      date_to: opts.to,
      row_count: sorted.length,
      total_credit: totalCredit,
      total_debit: totalDebit,
      net_balance: netBalance,
      issued_at: new Date().toISOString(),
      issued_by: opts.generatedBy || "Admin",
      expires_at: expiresAt,
      pdf_base64: pdfBase64,
    });
  }

  doc.save(filename);
  return filename;
}

export { formatINR };
