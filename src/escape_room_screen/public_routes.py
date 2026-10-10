from flask import Flask, Response, jsonify, render_template, send_from_directory

from .runtime import DisplayRuntime


def register_public_routes(app: Flask, runtime: DisplayRuntime) -> None:
    store = runtime.store
    broker = runtime.broker

    def display_snapshot() -> dict[str, object]:
        settings = store.get().to_dict()
        latest = store.get_latest_result()
        if latest is not None:
            settings["latest_result"] = latest.to_dict()
        return settings

    @app.get("/")
    def home() -> str:
        return render_template("home.html", settings=store.get())

    @app.get("/api/display")
    def get_display() -> Response:
        response = jsonify(display_snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response

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
