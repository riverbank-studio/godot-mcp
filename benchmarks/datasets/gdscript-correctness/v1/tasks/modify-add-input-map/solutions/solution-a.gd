extends Node

func _process(_delta: float) -> void:
	if Input.is_action_just_pressed("jump"):
		print("jump pressed")
	if Input.is_action_just_pressed("attack"):
		print("attack pressed")

func remap_action(action: StringName, new_key: Key) -> void:
	InputMap.action_erase_events(action)
	var event := InputEventKey.new()
	event.keycode = new_key
	InputMap.action_add_event(action, event)

func get_action_events(action: StringName) -> Array[InputEvent]:
	return InputMap.action_get_events(action)
