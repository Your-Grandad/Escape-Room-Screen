from datetime import date, datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

if TYPE_CHECKING:
    from .display import DisplaySettingsStore


def validate_report_dates(start: str, end: str) -> tuple[str | None, str | None]:
    for value in (start, end):
        if value:
            try:
                parsed = date.fromisoformat(value)
            except ValueError as error:
                raise ValueError("Report dates must use YYYY-MM-DD.") from error
            if parsed.isoformat() != value:
                raise ValueError("Report dates must use YYYY-MM-DD.")
    if start and end and start > end:
        raise ValueError("Report start date must not be after the end date.")
    return start or None, end or None


def create_result_report(
    title: str,
    entries: list["DisplaySettingsStore.LeaderboardEntry"],
    start: str | None,
    end: str | None,
) -> bytes:
    if len(entries) > 1000:
        raise ValueError("Reports are limited to 1,000 results. Select a narrower date range.")
    font = "ReportVera"
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(Path(reportlab.__file__).parent / "fonts" / "Vera.ttf")))
    styles = getSampleStyleSheet()
    for style in styles.byName.values():
        style.fontName = font
    completed = sum(entry.outcome == "completed" for entry in entries)
    failed = len(entries) - completed
    rate = completed * 100 / len(entries) if entries else 0
    content = [
        Paragraph(escape(title) + " — Room results", styles["Title"]),
        Paragraph(f"UTC finish dates: {start or 'All time'} to {end or 'Latest'}", styles["Normal"]),
        Paragraph(f"Generated: {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC", styles["Normal"]),
        Spacer(1, 12),
        Paragraph(
            f"Recorded runs: {len(entries)} · Completed: {completed} · Failed: {failed} · Completion rate: {rate:.1f}%",
            styles["Normal"],
        ),
        Spacer(1, 12),
    ]

    def clock(seconds: int) -> str:
        sign = "-" if seconds < 0 else ""
        seconds = abs(seconds)
        return f"{sign}{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"

    rows = [["#", "Team", "Outcome", "Players", "Taken", "Remaining", "Hints", "Penalties", "Finished (UTC)"]]
    for index, entry in enumerate(entries, 1):
        rows.append([
            str(index), Paragraph(escape(entry.group_name), styles["Normal"]),
            entry.outcome.capitalize(), str(entry.group_size), clock(entry.time_taken_seconds),
            clock(entry.time_remaining_seconds), str(entry.hints_used), str(entry.penalties),
            Paragraph(escape(entry.completed_at), styles["Normal"]),
        ])
    if entries:
        table = LongTable(rows, repeatRows=1, colWidths=[25, 135, 65, 45, 60, 65, 40, 55, 160])
        table.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font), ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#102a43")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f1f5f9")]),
            ("LINEBELOW", (0, 0), (-1, -1), .25, colors.lightgrey),
        ]))
        content.append(table)
    else:
        content.append(Paragraph("No recorded results in the selected date range.", styles["Normal"]))
    output = BytesIO()
    SimpleDocTemplate(output, pagesize=landscape(A4), rightMargin=36, leftMargin=36).build(content)
    return output.getvalue()
