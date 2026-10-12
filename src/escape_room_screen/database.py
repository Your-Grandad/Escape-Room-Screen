import sqlite3
from contextlib import closing
from pathlib import Path


def connect(database_path: Path | str) -> sqlite3.Connection:
    connection = sqlite3.connect(str(database_path))
    connection.row_factory = sqlite3.Row
    return connection


def initialize(database_path: Path | str) -> None:
    database_path = Path(database_path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(database_path)) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS hdmi_rotation (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270))
            );
            INSERT INTO hdmi_rotation (id, rotation) VALUES (1, 0)
            ON CONFLICT(id) DO NOTHING;

            CREATE TABLE IF NOT EXISTS display_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                background_colour TEXT NOT NULL,
                accent_colour TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO display_settings (
                id, title, message, background_colour, accent_colour
            )
            VALUES (1, 'Welcome', 'Your message appears here.', '#102a43', '#f6c453')
            ON CONFLICT(id) DO NOTHING;

            CREATE TABLE IF NOT EXISTS hints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                given_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS room_statistics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL,
                value TEXT NOT NULL,
                recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS room_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timer_started_at TEXT NOT NULL UNIQUE,
                completed_at TEXT NOT NULL,
                outcome TEXT NOT NULL DEFAULT 'completed',
                group_name TEXT NOT NULL,
                group_size INTEGER NOT NULL,
                hints_used INTEGER NOT NULL,
                penalties INTEGER NOT NULL,
                time_taken_seconds INTEGER NOT NULL,
                time_remaining_seconds INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gpio_mappings (
                pin INTEGER PRIMARY KEY,
                event TEXT NOT NULL,
                preset_id INTEGER
            );

            CREATE TABLE IF NOT EXISTS gpio_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pin INTEGER NOT NULL,
                event TEXT NOT NULL,
                accepted INTEGER NOT NULL,
                triggered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS gpio_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                paused INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO gpio_settings (id, paused) VALUES (1, 0)
            ON CONFLICT(id) DO NOTHING;

            CREATE TABLE IF NOT EXISTS gpio_output_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL UNIQUE,
                output_name TEXT,
                pin INTEGER CHECK (pin IS NULL OR pin BETWEEN 0 AND 27),
                state TEXT NOT NULL CHECK (state IN ('on', 'off', 'toggle', 'timed')),
                duration_seconds INTEGER,
                trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'room-complete')),
                CHECK (
                    (state = 'timed' AND duration_seconds IS NOT NULL AND duration_seconds > 0)
                    OR (state != 'timed' AND duration_seconds IS NULL)
                ),
                CHECK (
                    (output_name IS NOT NULL AND pin IS NULL)
                    OR (output_name IS NULL AND pin IS NOT NULL)
                )
            );

            CREATE TABLE IF NOT EXISTS action_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timer_started_at TEXT,
                action_type TEXT NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS hint_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video', 'audio')),
                title TEXT NOT NULL,
                message TEXT,
                media_filename TEXT,
                full_screen INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS admin_credentials (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                password_hash TEXT,
                session_version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO admin_credentials (id) VALUES (1)
            ON CONFLICT(id) DO NOTHING;

            CREATE TABLE IF NOT EXISTS admin_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT,
                is_superuser INTEGER NOT NULL DEFAULT 0,
                session_version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO admin_users (
                username, password_hash, is_superuser, session_version
            )
            SELECT 'admin', password_hash, 1, session_version
            FROM admin_credentials
            WHERE id = 1
            ON CONFLICT(username) DO NOTHING;
            """
        )
        existing_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(display_settings)")
        }
        gpio_mapping_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(gpio_mappings)")
        }
        if "preset_id" not in gpio_mapping_columns:
            connection.execute("ALTER TABLE gpio_mappings ADD COLUMN preset_id INTEGER")
        gpio_output_action_columns = {
            row["name"]: row
            for row in connection.execute("PRAGMA table_info(gpio_output_actions)")
        }
        if (
            "title" not in gpio_output_action_columns
            or "pin" not in gpio_output_action_columns
            or gpio_output_action_columns["output_name"]["notnull"]
            or "duration_seconds" not in gpio_output_action_columns
        ):
            connection.execute(
                "ALTER TABLE gpio_output_actions RENAME TO gpio_output_actions_legacy"
            )
            connection.execute(
                """
                CREATE TABLE gpio_output_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL UNIQUE,
                    output_name TEXT,
                    pin INTEGER CHECK (pin IS NULL OR pin BETWEEN 0 AND 27),
                    state TEXT NOT NULL CHECK (state IN ('on', 'off', 'toggle', 'timed')),
                    duration_seconds INTEGER,
                    trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'room-complete')),
                    CHECK (
                        (state = 'timed' AND duration_seconds IS NOT NULL AND duration_seconds > 0)
                        OR (state != 'timed' AND duration_seconds IS NULL)
                    ),
                    CHECK (
                        (output_name IS NOT NULL AND pin IS NULL)
                        OR (output_name IS NULL AND pin IS NOT NULL)
                    )
                )
                """
            )
            title_column = "title" if "title" in gpio_output_action_columns else "label"
            pin_column = "pin" if "pin" in gpio_output_action_columns else "NULL"
            connection.execute(
                f"""
                INSERT INTO gpio_output_actions (id, title, output_name, pin, state)
                SELECT id, {title_column}, output_name, {pin_column}, state
                FROM gpio_output_actions_legacy
                """
            )
            connection.execute("DROP TABLE gpio_output_actions_legacy")
        gpio_output_action_names = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(gpio_output_actions)")
        }
        if "trigger" not in gpio_output_action_names:
            connection.execute(
                "ALTER TABLE gpio_output_actions ADD COLUMN trigger TEXT NOT NULL "
                "DEFAULT 'manual' CHECK (trigger IN ('manual', 'room-complete'))"
            )
        for column in (
            "screen_rotation INTEGER NOT NULL DEFAULT 0 CHECK (screen_rotation IN (0, 90, 180, 270))",
            "timer_started_at TEXT",
            "timer_paused_at TEXT",
            "timer_duration_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (timer_duration_seconds > 0)",
            "timer_run_duration_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (timer_run_duration_seconds > 0)",
            "room_completed_at TEXT",
            "room_failed_at TEXT",
            "announcement TEXT",
            "announcement_expires_at TEXT",
            "background_image TEXT",
            "logo_image TEXT",
            "completion_message TEXT NOT NULL DEFAULT 'Congratulations!'",
            "failure_message TEXT NOT NULL DEFAULT 'Room failed'",
            "timer_remaining_seconds INTEGER",
            "auto_hint_remaining_minutes INTEGER",
            "auto_hint_message TEXT",
            "extra_time_seconds INTEGER NOT NULL DEFAULT 0",
            "penalty_time_seconds INTEGER NOT NULL DEFAULT 0",
            "announcement_media_type TEXT",
            "announcement_media_filename TEXT",
            "announcement_media_full_screen INTEGER NOT NULL DEFAULT 0",
            "notification_sound_filename TEXT",
            "success_sound_filename TEXT",
            "failed_sound_filename TEXT",
            "screen_layout TEXT",
            "screen_layout_enabled INTEGER NOT NULL DEFAULT 0",
            "media_settings TEXT",
            "briefing_token TEXT",
            "briefing_filename TEXT",
        ):
            name = column.split()[0]
            if name not in existing_columns:
                connection.execute(f"ALTER TABLE display_settings ADD COLUMN {column}")

        hint_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(hints)")
        }
        if "timer_remaining_seconds" not in hint_columns:
            connection.execute(
                "ALTER TABLE hints ADD COLUMN timer_remaining_seconds INTEGER NOT NULL DEFAULT 3600"
            )
        for column in ("media_type TEXT", "media_filename TEXT"):
            name = column.split()[0]
            if name not in hint_columns:
                connection.execute(f"ALTER TABLE hints ADD COLUMN {column}")
        preset_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(hint_presets)")
        }
        if "full_screen" not in preset_columns:
            connection.execute(
                "ALTER TABLE hint_presets ADD COLUMN full_screen INTEGER NOT NULL DEFAULT 0"
            )
        if "category" not in preset_columns:
            connection.execute(
                "ALTER TABLE hint_presets ADD COLUMN category TEXT NOT NULL DEFAULT ''"
            )
        preset_table = connection.execute(
            """
            SELECT sql
            FROM sqlite_master
            WHERE type = 'table' AND name = 'hint_presets'
            """
        ).fetchone()
        if preset_table is not None and "'audio'" not in preset_table["sql"]:
            connection.execute(
                "ALTER TABLE hint_presets RENAME TO hint_presets_without_audio"
            )
            connection.execute(
                """
                CREATE TABLE hint_presets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL
                        CHECK (kind IN ('text', 'image', 'video', 'audio')),
                    title TEXT NOT NULL,
                    message TEXT,
                    media_filename TEXT,
                    full_screen INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    category TEXT NOT NULL DEFAULT ''
                )
                """
            )
            connection.execute(
                """
                INSERT INTO hint_presets (
                    id, kind, title, message, media_filename, full_screen,
                    created_at, category
                )
                SELECT
                    id, kind, title, message, media_filename, full_screen,
                    created_at, category
                FROM hint_presets_without_audio
                """
            )
            connection.execute("DROP TABLE hint_presets_without_audio")
        result_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(room_results)")
        }
        if "outcome" not in result_columns:
            connection.execute(
                "ALTER TABLE room_results "
                "ADD COLUMN outcome TEXT NOT NULL DEFAULT 'completed'"
            )
        connection.commit()


def get_admin_user_by_username(
    database_path: Path | str,
    username: str,
) -> sqlite3.Row | None:
    with closing(connect(database_path)) as connection:
        return connection.execute(
            """
            SELECT id, username, password_hash, is_superuser, session_version
            FROM admin_users
            WHERE username = ?
            """,
            (username,),
        ).fetchone()


def get_admin_user(database_path: Path | str, user_id: int) -> sqlite3.Row | None:
    with closing(connect(database_path)) as connection:
        return connection.execute(
            """
            SELECT id, username, password_hash, is_superuser, session_version
            FROM admin_users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()


def list_admin_users(database_path: Path | str) -> list[sqlite3.Row]:
    with closing(connect(database_path)) as connection:
        return connection.execute(
            """
            SELECT id, username, is_superuser, created_at
            FROM admin_users
            ORDER BY is_superuser DESC, username COLLATE NOCASE
            """
        ).fetchall()


def create_admin_user(
    database_path: Path | str,
    username: str,
    password_hash: str,
) -> None:
    try:
        with closing(connect(database_path)) as connection:
            connection.execute(
                """
                INSERT INTO admin_users (username, password_hash)
                VALUES (?, ?)
                """,
                (username, password_hash),
            )
            connection.commit()
    except sqlite3.IntegrityError as error:
        raise ValueError("A user with that username already exists.") from error


def update_admin_user_password(
    database_path: Path | str,
    user_id: int,
    password_hash: str,
) -> None:
    with closing(connect(database_path)) as connection:
        cursor = connection.execute(
            """
            UPDATE admin_users
            SET password_hash = ?,
                session_version = session_version + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (password_hash, user_id),
        )
        connection.commit()
    if cursor.rowcount != 1:
        raise ValueError("User not found.")


def delete_admin_user(database_path: Path | str, user_id: int) -> None:
    with closing(connect(database_path)) as connection:
        user = connection.execute(
            "SELECT is_superuser FROM admin_users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if user is None:
            raise ValueError("User not found.")
        if user["is_superuser"]:
            raise ValueError("The superuser cannot be deleted.")
        connection.execute("DELETE FROM admin_users WHERE id = ?", (user_id,))
        connection.commit()
