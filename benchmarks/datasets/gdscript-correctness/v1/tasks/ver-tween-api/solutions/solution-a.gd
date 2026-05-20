extends Node2D

func animate_to_position() -> void:
	var tween := create_tween()
	tween.tween_property(self, "position", Vector2(500, 300), 1.0)\
		.set_trans(Tween.TRANS_SINE)\
		.set_ease(Tween.EASE_IN_OUT)
