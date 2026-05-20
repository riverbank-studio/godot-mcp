func animate_popup(panel: Control) -> void:
	panel.visible = true
	var tween := create_tween()
	tween.tween_property(panel, "modulate:a", 1.0, 0.3).from(0.0)
	tween.tween_property(panel, "scale", Vector2(1.0, 1.0), 0.2).from(Vector2(0.8, 0.8))
