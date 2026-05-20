extends CanvasLayer

func fade_out() -> void:
	var tween := create_tween()
	tween.tween_property(self, "modulate:a", 0.0, 0.5)
	await tween.play()  # bug: tween.play() returns void, not a signal
	print("fade complete")
