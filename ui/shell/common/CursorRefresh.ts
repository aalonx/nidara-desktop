import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { safeDisconnect } from "../core/signals"

/**
 * A new cursor theme or size does not reach the cursor that is ALREADY on screen.
 * Neither side of the protocol re-applies it, and both were read to check:
 *
 *  - **Hyprland** (`src/pointer/cursor/CursorManager.cpp`, 0.56.2): `hyprctl setcursor`
 *    → `dispatchSetCursor` → `changeTheme()` reloads the theme and calls
 *    `updateTheme()`, which schedules frames (`AQ_SCHEDULE_CURSOR_SHAPE`) but never
 *    re-issues `setCursorFromName`. The pointer keeps the buffer it already had, so
 *    those frames repaint the OLD cursor.
 *  - **GTK4** (`gdk/wayland/gdkdisplay-wayland.c`, 4.22): the whole body of
 *    `_gdk_wayland_display_set_cursor_theme()` is
 *    `display_wayland->cursor_theme_size = size ? size : 24;`. It caches the size; the
 *    upload happens at the next `wl_pointer.enter`.
 *
 * Both therefore refresh on the same event — the next `enter` — which is exactly why
 * moving the pointer out of the window and back in "applies" the setting, and why the
 * setting looks broken while you sit inside the window you changed it from.
 *
 * This makes the shell's own surfaces re-issue their cursor instead of waiting for
 * that enter.
 *
 * ⚠️ **Scope: Nidara's windows only.** A third-party app is a separate client and
 * still waits for its own `enter`; nothing a shell can do reaches it. The fix that
 * would cover the whole desktop is upstream, in `changeTheme()` re-applying the shape
 * in force — the compositor is the one party that knows every pointer.
 *
 * Confirmed by a person, both halves: size 24 → 96 and theme Adwaita → Qogir-Light,
 * each with the pointer parked inside a shell window and not touched.
 *
 * ⚠️⚠️ **A screenshot cannot verify this, and will say it does not work.** `grim -c`
 * (screencopy with the cursor composited in) hands back a STALE cursor: it refreshes
 * its copy on the pointer-focus path, i.e. on the same `enter` this whole file exists
 * to avoid. Measured against a human looking at the same screen at the same instant,
 * with the size at 96 and the pointer verifiably still for a minute: the capture
 * reported the 24-px box, the eyes reported a cursor four times bigger, and the eyes
 * were right. The instrument had the same disease as the patient. Verify this with a
 * person, or on the wire with `WAYLAND_DEBUG=1` — never with a capture.
 *
 * ⚠️ And check WHAT IS UNDER THE POINTER before believing a negative. Restarting the
 * shell destroys the Settings window (it is created lazily and hides on close), so a
 * test that restarts and then changes a setting leaves the pointer over the wallpaper —
 * no shell surface, nothing for this to bump, and a perfectly convincing "it does not
 * work". That is what made the theme half look broken after the size half was already
 * confirmed working. `listWindows` + `hyprctl cursorpos` answers it in one line.
 */
function bumpCursor(w: Gtk.Widget) {
    // 🔑 It has to be a different SHAPE, not merely a different object. GDK compares
    // cursors by EQUALITY, not identity, so handing it a fresh `Gdk.Cursor` with the
    // same name is a no-op: measured under `WAYLAND_DEBUG=1` with the pointer verified
    // inside the surface, that version put **nothing** on the wire. Going through
    // another shape and straight back does:
    //
    //     -> wp_cursor_shape_device_v1#40.set_shape(21423, 8)   // crosshair
    //     -> wp_cursor_shape_device_v1#40.set_shape(21423, 1)   // default, again
    //
    // 9 µs apart, both flushed in the same main-loop iteration, so the compositor
    // applies them in one pass and no frame can be composited between the two — the
    // crosshair is never drawn. The widget ends up holding exactly the cursor it held
    // before; only the picture on the compositor is new.
    const cur = w.get_cursor()
    w.set_cursor(Gdk.Cursor.new_from_name("crosshair", null))
    w.set_cursor(cur)
}

/**
 * Re-apply the cursor on every shell surface.
 *
 * The toplevel is the right widget to bump because the surface's cursor is the one of
 * the widget under the pointer, walking UP to the first that has one — and inside the
 * shell almost nothing sets its own. The exceptions are three Settings pages that call
 * `set_cursor_from_name("pointer")` on rows (Apps, App icons, Autostart), and none of
 * them can change the cursor theme or size, so the pointer cannot be over one of those
 * rows at the moment this runs.
 */
export function refreshShellCursors(windows: Gtk.Window[]) {
    for (const w of windows) {
        if (!w.get_mapped()) continue
        bumpCursor(w)
    }
}

/**
 * Bind the refresh to the moment GTK LEARNS the new value.
 *
 * 🔑 The trigger is `Gtk.Settings`, not ThemeManager's `changed`, and that is the
 * load-bearing part. `ThemeManager.setCursorSize` emits `changed` while its two writes
 * are still in flight — `gsettings` and `hyprctl setcursor` — and a bump at that moment
 * would faithfully re-issue the OLD picture and look like the bug it is meant to fix.
 *
 * Which of the two writes actually decides what you SEE is worth knowing: GTK4 4.22
 * drives the cursor through `wp_cursor_shape_device_v1.set_shape` (measured on the
 * wire), so the picture is drawn by the COMPOSITOR from its own theme — `hyprctl
 * setcursor` — and GTK's `gtk-cursor-theme-size` never reaches the screen at all here.
 * It is used as the trigger anyway, as a proxy for "both writes have landed": it
 * arrives over the settings portal, a D-Bus round trip that takes up to ~1.5 s
 * (measured), while `hyprctl` is a local socket call issued first. The slower of the
 * two signals is the safe one to wait for.
 *
 * It also covers a change ThemeManager never sees: it watches `color-scheme` and
 * `font-name` on GSettings, not the cursor keys, so a `gsettings set` from a terminal
 * (or the other Settings window) emits no `changed` at all — but the portal still
 * notifies GTK, so this still fires.
 */
export function bindCursorThemeRefresh(getWindows: () => Gtk.Window[]): () => void {
    const settings = Gtk.Settings.get_default()
    if (!settings) return () => {}
    const ids = ["notify::gtk-cursor-theme-size", "notify::gtk-cursor-theme-name"]
        .map((sig) => settings.connect(sig, () => refreshShellCursors(getWindows())))
    return () => ids.forEach((id) => safeDisconnect(settings, id))
}
