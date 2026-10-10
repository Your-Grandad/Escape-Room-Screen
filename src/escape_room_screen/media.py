import re
from typing import TypedDict


class MediaSettings(TypedDict):
    font_filename: str | None
    text_colour: str
    hint_colour: str
    background_video: str | None
    background_video_enabled: bool
    soundtrack: str | None
    soundtrack_enabled: bool
    soundtrack_volume: int
    briefing_video: str | None
    briefing_enabled: bool


def default_media_settings() -> MediaSettings:
    return {
        "font_filename": None, "text_colour": "#f8fafc", "hint_colour": "#f6c453",
        "background_video": None, "background_video_enabled": False,
        "soundtrack": None, "soundtrack_enabled": False, "soundtrack_volume": 30,
        "briefing_video": None, "briefing_enabled": False,
    }


def validate_media_settings(value: object) -> MediaSettings:
    defaults = default_media_settings()
    if not isinstance(value, dict) or set(value) != set(defaults):
        raise ValueError("A complete media settings object is required.")
    for key, extensions in (
        ("font_filename", "woff2|woff|ttf|otf"),
        ("background_video", "mp4|webm|mov"),
        ("briefing_video", "mp4|webm|mov"),
        ("soundtrack", "mp3|wav|ogg|m4a|aac"),
    ):
        filename = value[key]
        if filename is not None and (
            not isinstance(filename, str)
            or not re.fullmatch(rf"[0-9a-f]{{32}}\.(?:{extensions})", filename)
        ):
            raise ValueError(f"Invalid uploaded filename for {key}.")
    for key in ("text_colour", "hint_colour"):
        if not isinstance(value[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value[key]):
            raise ValueError("Text and hint colours must be six-digit hex colours.")
    for key in ("background_video_enabled", "soundtrack_enabled", "briefing_enabled"):
        if type(value[key]) is not bool:
            raise ValueError(f"{key} must be true or false.")
    if type(value["soundtrack_volume"]) is not int or not 0 <= value["soundtrack_volume"] <= 100:
        raise ValueError("Soundtrack volume must be an integer from 0 to 100.")
    for enabled, filename in (
        ("background_video_enabled", "background_video"),
        ("soundtrack_enabled", "soundtrack"), ("briefing_enabled", "briefing_video"),
    ):
        if value[enabled] and not value[filename]:
            raise ValueError(f"Upload {filename} before enabling it.")
    return {
        "font_filename": value["font_filename"],
        "text_colour": value["text_colour"],
        "hint_colour": value["hint_colour"],
        "background_video": value["background_video"],
        "background_video_enabled": value["background_video_enabled"],
        "soundtrack": value["soundtrack"],
        "soundtrack_enabled": value["soundtrack_enabled"],
        "soundtrack_volume": value["soundtrack_volume"],
        "briefing_video": value["briefing_video"],
        "briefing_enabled": value["briefing_enabled"],
    }
