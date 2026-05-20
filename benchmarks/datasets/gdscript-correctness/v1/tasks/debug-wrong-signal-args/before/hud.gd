extends Control

## HealthComponent emits: health_changed(old_value: int, new_value: int)
@onready var _health_component: Node = $HealthComponent
@onready var _bar: ProgressBar = $HealthBar

func _ready() -> void:
	_health_component.health_changed.connect(_on_health_changed)

## bug: missing old_value parameter — signal passes two ints
func _on_health_changed(new_value: int) -> void:
	_bar.value = new_value
