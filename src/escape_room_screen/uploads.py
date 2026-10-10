from collections.abc import Iterable
from pathlib import Path
from uuid import uuid4

from werkzeug.datastructures import FileStorage


IMAGE_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".webp"}
IMAGE_SIGNATURES = {
    ".gif": (b"GIF87a", b"GIF89a"),
    ".jpeg": (b"\xff\xd8\xff",),
    ".jpg": (b"\xff\xd8\xff",),
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".webp": (b"RIFF",),
}
SOUND_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".aac"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov"}


def save_background_image(
    upload: FileStorage | None,
    upload_folder: Path,
) -> str | None:
    return _save_image_upload(
        upload,
        upload_folder,
        "Background image must be a PNG, JPEG, GIF, or WebP file.",
    )


def save_logo_image(
    upload: FileStorage | None,
    upload_folder: Path,
) -> str | None:
    return _save_image_upload(
        upload,
        upload_folder,
        "Logo image must be a PNG, JPEG, GIF, or WebP file.",
    )


def save_hint_media(
    upload: FileStorage | None,
    kind: str,
    upload_folder: Path,
) -> str | None:
    if upload is None or not upload.filename:
        return None
    extension = Path(upload.filename).suffix.lower()
    if kind == "image":
        return _save_image_upload(
            upload,
            upload_folder,
            "Hint image must be a PNG, JPEG, GIF, or WebP file.",
        )
    if kind == "video":
        if extension not in VIDEO_EXTENSIONS:
            raise ValueError("Hint video must be an MP4, WebM, or MOV file.")
        return _save_upload(upload, upload_folder, extension)
    if kind == "audio":
        return _save_sound_upload(
            upload,
            upload_folder,
            "Hint audio must be one of: MP3, WAV, OGG, M4A, AAC.",
        )
    raise ValueError("Unsupported hint media kind.")


def save_sound(upload: FileStorage | None, upload_folder: Path) -> str | None:
    if upload is None or not upload.filename:
        return None
    return _save_sound_upload(
        upload,
        upload_folder,
        "Sound file must be one of: MP3, WAV, OGG, M4A, AAC.",
    )


def save_video(upload: FileStorage | None, upload_folder: Path) -> str | None:
    if upload is None or not upload.filename:
        return None
    extension = Path(upload.filename).suffix.lower()
    header = upload.stream.read(12)
    upload.stream.seek(0)
    if extension not in VIDEO_EXTENSIONS:
        raise ValueError("Video must be an MP4, WebM, or MOV file.")
    if (
        extension == ".webm" and not header.startswith(b"\x1a\x45\xdf\xa3")
        or extension in (".mp4", ".mov") and header[4:8] != b"ftyp"
    ):
        raise ValueError("Invalid video container. Use MP4 (H.264 recommended) or WebM.")
    return _save_upload(upload, upload_folder, extension)


def save_font(upload: FileStorage | None, upload_folder: Path) -> str | None:
    if upload is None or not upload.filename:
        return None
    extension = Path(upload.filename).suffix.lower()
    signatures = {".woff2": b"wOF2", ".woff": b"wOFF", ".ttf": b"\x00\x01\x00\x00", ".otf": b"OTTO"}
    header = upload.stream.read(4)
    upload.stream.seek(0, 2)
    size = upload.stream.tell()
    upload.stream.seek(0)
    if extension not in signatures or header != signatures[extension] or size > 2 * 1024 * 1024:
        raise ValueError("Font must be a valid WOFF2, WOFF, TTF, or OTF file, no larger than 2 MiB.")
    return _save_upload(upload, upload_folder, extension)


def _save_sound_upload(
    upload: FileStorage,
    upload_folder: Path,
    error_message: str,
) -> str:
    extension = Path(upload.filename).suffix.lower()
    if extension not in SOUND_EXTENSIONS:
        raise ValueError(error_message)
    header = upload.stream.read(12)
    upload.stream.seek(0)
    if extension == ".wav" and not header.startswith(b"RIFF"):
        raise ValueError("Invalid WAV file.")
    if extension == ".ogg" and not header.startswith(b"OggS"):
        raise ValueError("Invalid Ogg file.")
    return _save_upload(upload, upload_folder, extension)


def delete_uploaded_files(upload_folder: Path, filenames: Iterable[str | None]) -> None:
    for filename in filenames:
        if filename:
            (upload_folder / filename).unlink(missing_ok=True)


def _save_image_upload(
    upload: FileStorage | None,
    upload_folder: Path,
    error_message: str,
) -> str | None:
    if upload is None or not upload.filename:
        return None
    extension = Path(upload.filename).suffix.lower()
    header = upload.stream.read(12)
    upload.stream.seek(0)
    is_valid_webp = (
        extension == ".webp"
        and header[:4] == b"RIFF"
        and header[8:12] == b"WEBP"
    )
    if (
        extension not in IMAGE_EXTENSIONS
        or (extension != ".webp" and not header.startswith(IMAGE_SIGNATURES[extension]))
        or (extension == ".webp" and not is_valid_webp)
    ):
        raise ValueError(error_message)
    return _save_upload(upload, upload_folder, extension)


def _save_upload(upload: FileStorage, upload_folder: Path, extension: str) -> str:
    saved_name = f"{uuid4().hex}{extension}"
    saved_path = upload_folder / saved_name
    try:
        upload.save(saved_path)
    except OSError:
        saved_path.unlink(missing_ok=True)
        raise
    return saved_name
