extends Control

@onready var _bar: ProgressBar = $ProgressBar
@onready var _label: Label = $Label

var _health_component: Node

func _ready() -> void:
	_health_component = get_tree().get_first_node_in_group("health_component")
	if _health_component:
		_health_component.health_changed.connect(_on_health_changed)

func _on_health_changed(old_value: int, new_value: int) -> void:
	_bar.max_value = _health_component.max_health
	_bar.value = new_value
	_label.text = "%d / %d" % [new_value, _health_component.max_health]
