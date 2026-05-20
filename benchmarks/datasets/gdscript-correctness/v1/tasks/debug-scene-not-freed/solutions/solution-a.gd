extends Node

@export var popup_scene: PackedScene

func show_popup() -> void:
	var popup := popup_scene.instantiate()
	add_child(popup)
	popup.close_requested.connect(func(): popup.queue_free())
