import json
import tempfile
import unittest
from contextlib import closing
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from escape_room_screen import create_app
from escape_room_screen.database import connect, initialize
from escape_room_screen.display import DisplaySettingsStore
from escape_room_screen.media import default_media_settings, validate_media_settings
from escape_room_screen.reports import create_result_report, validate_report_dates


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.db = Path(self.folder.name) / "screen.db"
        self.uploads = Path(self.folder.name) / "uploads"
        self.app = create_app({
            "TESTING": True, "SECRET_KEY": "test", "ADMIN_PASSWORD": "test-password",
            "DATABASE": str(self.db), "UPLOAD_FOLDER": str(self.uploads),
            "GPIO_INPUTS": {}, "GPIO_OUTPUTS": {},
        })
        self.addCleanup(self.app.extensions["gpio"].close)
        self.addCleanup(self.app.extensions["display_runtime"].cancel_timer_events)
        self.store = self.app.extensions["display_store"]
        self.client = self.app.test_client()
        self.client.post("/admin/login", data={"username": "admin", "password": "test-password"})
        with self.client.session_transaction() as session:
            self.csrf = session["csrf_token"]

    def form(self, **changes):
        values = {
            "csrf_token": self.csrf, "text_colour": "#123456",
            "hint_colour": "#abcdef", "soundtrack_volume": "25",
        }
        values.update(changes)
        return values

    def configure_briefing(self):
        media = default_media_settings()
        media.update(briefing_video="a" * 32 + ".mp4", briefing_enabled=True)
        self.store.save_media_settings(media)

    def test_media_defaults_and_migrations_preserve_existing_settings(self):
        before = self.store.get()
        self.assertEqual(before.media_settings["hint_colour"], before.accent_colour)
        self.assertFalse(before.media_settings["background_video_enabled"])
        initialize(self.db)
        initialize(self.db)
        self.assertEqual(self.store.get(), before)
        response = self.client.get("/admin/media")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Fonts &amp; media", response.data)
        self.assertIn(b'preload="none"', self.client.get("/").data)
        self.assertIn(b"Export PDF report", self.client.get("/admin/stats").data)

    def test_uploads_persist_replace_and_remove_without_changing_gameplay(self):
        before = self.store.get()
        response = self.client.post("/admin/media", data=self.form(
            font_filename=(BytesIO(b"wOF2" + b"\0" * 12), "font.woff2"),
            background_video=(BytesIO(b"\0\0\0\x18ftypmp42"), "bg.mp4"),
            briefing_video=(BytesIO(b"\x1a\x45\xdf\xa3" + b"\0" * 12), "brief.webm"),
            soundtrack=(BytesIO(b"RIFF1234WAVE"), "music.wav"),
            background_video_enabled="on", briefing_enabled="on", soundtrack_enabled="on",
        ))
        self.assertEqual(response.status_code, 302)
        media = self.store.get().media_settings
        self.assertEqual(media["soundtrack_volume"], 25)
        for key in ("font_filename", "background_video", "briefing_video", "soundtrack"):
            self.assertTrue((self.uploads / media[key]).is_file())
        self.assertEqual(DisplaySettingsStore(self.db).get().media_settings, media)
        self.assertEqual(self.store.get().timer_started_at, before.timer_started_at)
        old_font = media["font_filename"]
        response = self.client.post("/admin/media", data=self.form(
            font_filename=(BytesIO(b"OTTO" + b"\0" * 12), "new.otf"),
        ))
        self.assertEqual(response.status_code, 302)
        self.assertFalse((self.uploads / old_font).exists())
        new_font = self.store.get().media_settings["font_filename"]
        self.client.post("/admin/media", data=self.form(remove_font_filename="on"))
        self.assertFalse((self.uploads / new_font).exists())
        self.assertIsNone(self.store.get().media_settings["font_filename"])

    def test_invalid_uploads_and_settings_leave_database_and_files_unchanged(self):
        before = self.store.get()
        for data in (
            self.form(font_filename=(BytesIO(b"bad font"), "font.woff2")),
            self.form(background_video=(BytesIO(b"not video"), "bad.mp4")),
            self.form(background_video=(BytesIO(b"ftypxxxx"), "bad.exe")),
            self.form(font_filename=(BytesIO(b"wOF2" + b"\0" * (2 * 1024 * 1024)), "huge.woff2")),
            self.form(soundtrack_volume="101"),
            self.form(soundtrack_volume="nan"),
            self.form(text_colour="red"),
            self.form(background_video_enabled="on"),
            self.form(
                font_filename=(BytesIO(b"OTTO"), "ok.otf"),
                background_video=(BytesIO(b"bad"), "bad.mp4"),
            ),
        ):
            with self.subTest(data=list(data)):
                response = self.client.post("/admin/media", data=data)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.store.get(), before)
                self.assertEqual(list(self.uploads.iterdir()), [])

    def test_auth_csrf_and_missing_or_malformed_completion_tokens(self):
        other = self.app.test_client()
        self.assertEqual(other.get("/admin/media").status_code, 302)
        self.assertEqual(other.get("/admin/reports/results.pdf").status_code, 302)
        self.assertEqual(other.post("/admin/media", data=self.form()).status_code, 401)
        self.assertEqual(other.post("/admin/briefing/skip").status_code, 401)
        self.assertEqual(self.client.post("/admin/media").status_code, 400)
        self.assertEqual(self.client.post("/admin/briefing/skip").status_code, 400)
        for payload in ({}, {"token": "bad"}, {"token": None}, ["bad"]):
            self.assertEqual(other.post("/api/briefing/finished", json=payload).status_code, 400)
        self.assertEqual(other.post("/api/briefing/finished", json={"token": "a" * 43}).status_code, 409)
        self.assertEqual(other.post("/api/briefing/finished", json={"token": "a" * 600}).status_code, 400)

    def test_briefing_start_completion_is_atomic_and_captures_duration(self):
        self.configure_briefing()
        runtime = self.app.extensions["display_runtime"]
        with patch.object(runtime, "publish_current_settings") as publish:
            response = self.client.post("/admin/timer/start", headers={"X-CSRF-Token": self.csrf})
            self.assertEqual(response.status_code, 200)
            publish.assert_called_once()
        pending = self.store.get()
        self.assertIsNone(pending.timer_started_at)
        self.assertFalse(pending.timer_is_running)
        self.assertEqual(len(pending.briefing_token), 43)
        self.assertEqual(self.client.post(
            "/admin/timer/start", headers={"X-CSRF-Token": self.csrf},
        ).status_code, 409)
        self.assertEqual(self.client.post("/admin/media", data=self.form()).status_code, 409)
        with closing(connect(self.db)) as connection:
            connection.execute("UPDATE display_settings SET timer_duration_seconds = 1234 WHERE id = 1")
            connection.commit()
        token = pending.briefing_token
        self.assertEqual(self.client.post("/api/briefing/finished", json={"token": token}).status_code, 200)
        started = self.store.get()
        self.assertTrue(started.timer_is_running)
        self.assertEqual(started.timer_run_duration_seconds, 1234)
        self.assertIsNone(started.briefing_token)
        self.assertEqual(self.client.post("/api/briefing/finished", json={"token": token}).status_code, 409)
        self.assertEqual(self.store.get(), started)

    def test_briefing_cancellation_reset_skip_and_restarts_invalidate_old_tokens(self):
        self.configure_briefing()
        first = self.store.start_timer_if_not_running()
        initialize(self.db)
        self.assertEqual(DisplaySettingsStore(self.db).get().briefing_token, first.briefing_token)
        self.assertEqual(self.client.post(
            "/admin/briefing/cancel", data={"csrf_token": self.csrf},
        ).status_code, 302)
        second = self.store.start_timer_if_not_running()
        self.assertNotEqual(second.briefing_token, first.briefing_token)
        self.assertIsNone(self.store.finish_briefing(first.briefing_token))
        self.store.reset_timer()
        self.assertIsNone(self.store.finish_briefing(second.briefing_token))
        third = self.store.start_timer_if_not_running()
        self.assertEqual(self.client.post(
            "/admin/briefing/skip", data={"csrf_token": self.csrf},
        ).status_code, 302)
        started = self.store.get()
        self.assertTrue(started.timer_is_running)
        # A late cancellation must not reset an already-started timer.
        self.assertIsNone(self.store.cancel_briefing(third.briefing_token))
        self.assertEqual(self.store.get(), started)

    def test_server_media_override_keeps_normal_start_and_gpio_briefing_selection(self):
        self.configure_briefing()
        runtime = self.app.extensions["display_runtime"]
        runtime._start_timer_from_gpio(22, "start-timer")
        self.assertIsNotNone(self.store.get().briefing_token)
        self.store.reset_timer()
        self.app.config["DISABLE_SCREEN_MEDIA"] = True
        runtime._start_timer_from_gpio(22, "start-timer")
        self.assertTrue(self.store.get().timer_is_running)
        self.assertIsNone(self.store.get().briefing_token)
        self.store.reset_timer()
        self.client.post("/admin/timer/start", headers={"X-CSRF-Token": self.csrf})
        self.assertTrue(self.store.get().timer_is_running)

    def test_corrupt_media_has_logged_fallback(self):
        with closing(connect(self.db)) as connection:
            connection.execute("UPDATE display_settings SET media_settings = ?", ('{"bad":1}',))
            connection.commit()
        with self.assertLogs("escape_room_screen.display", level="WARNING"):
            settings = self.store.get()
        self.assertTrue(settings.media_settings_error)
        self.assertFalse(settings.media_settings["briefing_enabled"])

    def test_validation_rejects_non_boolean_path_and_volume_values(self):
        for key, value in (
            ("briefing_enabled", 1), ("soundtrack_volume", True),
            ("font_filename", "../font.ttf"), ("text_colour", "url(x)"),
        ):
            media = default_media_settings()
            media[key] = value
            with self.assertRaises(ValueError):
                validate_media_settings(media)

    def seed_results(self):
        with closing(connect(self.db)) as connection:
            for index, (day, outcome, remaining) in enumerate((
                ("2026-01-01", "completed", 500), ("2026-01-02", "failed", -15),
                ("2026-01-02", "completed", 700), ("2026-01-03", "completed", 100),
            )):
                connection.execute(
                    "INSERT INTO room_results (timer_started_at, completed_at, outcome, group_name, "
                    "group_size, hints_used, penalties, time_taken_seconds, time_remaining_seconds) "
                    "VALUES (?, ?, ?, ?, 4, 2, 1, 300, ?)",
                    (f"2026-01-01T00:00:0{index}+00:00", f"{day}T12:00:00+00:00",
                     outcome, "Team & <résumé> " + str(index), remaining),
                )
            connection.commit()

    def test_pdf_dates_ranking_headers_empty_report_and_bounds(self):
        self.seed_results()
        entries = self.store.get_leaderboard("2026-01-02", "2026-01-02")
        self.assertEqual([entry.outcome for entry in entries], ["completed", "failed"])
        self.assertEqual(len(self.store.get_leaderboard(limit=1)), 1)
        with patch("escape_room_screen.admin_routes.create_result_report", wraps=create_result_report) as report:
            response = self.client.get("/admin/reports/results.pdf?start=2026-01-02&end=2026-01-02")
            self.assertEqual(len(report.call_args.args[1]), 2)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data.startswith(b"%PDF-"))
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertIn("attachment", response.headers["Content-Disposition"])
        empty = self.client.get("/admin/reports/results.pdf?start=2027-01-01")
        self.assertEqual(empty.status_code, 200)
        self.assertTrue(empty.data.startswith(b"%PDF-"))
        for query in ("start=2026-02-30", "start=20260101", "start=2026-03-01&end=2026-01-01"):
            self.assertEqual(self.client.get("/admin/reports/results.pdf?" + query).status_code, 400)
        with self.assertRaisesRegex(ValueError, "1,000"):
            create_result_report("Room", entries * 501, None, None)
        self.assertEqual(validate_report_dates("", ""), (None, None))


if __name__ == "__main__":
    unittest.main()
