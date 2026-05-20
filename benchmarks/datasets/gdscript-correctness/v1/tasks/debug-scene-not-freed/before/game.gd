extends Node

@export var popup_scene: PackedScene

func show_popup() -> void:
	var popup := popup_scene.instantiate()
	add_child(popup)
	# bug: popup.close_requested signal is never connected
	# popup leaks every time show_popup() is called
