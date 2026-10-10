from flask import Flask, Response, jsonify, render_template, request, send_from_directory
import re

from .runtime import DisplayRuntime


def register_public_routes(app: Flask, runtime: DisplayRuntime) -> None:
    store = runtime.store
    broker = runtime.broker

    def display_snapshot() -> dict[str, object]:
        settings = store.get().to_dict()
        if app.config["DISABLE_CUSTOM_LAYOUT"]:
            settings["screen_layout_enabled"] = False
        latest = store.get_latest_result()
        if latest is not None:
            settings["latest_result"] = latest.to_dict()
        return settings

    @app.get("/")
    def home() -> str:
        return render_template(
            "home.html", settings=store.get(),
            layout_disabled=app.config["DISABLE_CUSTOM_LAYOUT"],
        )

    @app.get("/api/display")
    def get_display() -> Response:
        response = jsonify(display_snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/api/briefing/finished")
    def briefing_finished() -> Response:
        # Only the capability for the current briefing can transition this run.
        if request.content_length is None or request.content_length > 512:
            return jsonify(error="A small briefing completion object is required."), 400
        values = request.get_json(silent=True)
        token = values.get("token") if isinstance(values, dict) else None
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return jsonify(error="A valid briefing token is required."), 400
        settings = store.finish_briefing(token)
        if settings is None:
            return jsonify(error="This briefing is no longer active."), 409
        runtime.record_action("briefing", "Briefing finished; timer started")
        runtime.publish_current_settings()
        runtime.schedule_timer_events(settings)
        return jsonify(settings.to_dict())

    @app.get("/api/gpio/activity")
    def get_gpio_activity() -> Response:
        paused, activity = store.get_gpio_activity()
        return jsonify(
            paused=paused,
            interaction_active=not paused and store.get().timer_is_running,
            activity=[
                {
                    "pin": entry.pin,
                    "event": entry.event,
                    "accepted": entry.accepted,
                    "triggered_at": entry.triggered_at,
                }
                for entry in activity
            ],
        )

    @app.get("/uploads/<path:filename>")
    def uploaded_file(filename: str) -> Response:
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

    @app.get("/events")
    def display_events() -> Response:
        return Response(
            broker.stream(display_snapshot),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )
