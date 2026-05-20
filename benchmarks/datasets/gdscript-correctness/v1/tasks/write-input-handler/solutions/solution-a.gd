extends Node

signal clicked(position: Vector2)
signal cancel_requested

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			clicked.emit(event.position)

func _process(_delta: float) -> void:
	if Input.is_action_just_pressed("ui_cancel"):
		cancel_requested.emit()
