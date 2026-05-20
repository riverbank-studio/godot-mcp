class_name HealthComponent
extends Node

signal health_changed(old_value: int, new_value: int)
signal died

@export var max_health: int = 100
var _current_health: int

func _ready() -> void:
	_current_health = max_health

func take_damage(amount: int) -> void:
	var old := _current_health
	_current_health = clampi(_current_health - amount, 0, max_health)
	health_changed.emit(old, _current_health)
	if _current_health == 0:
		died.emit()

func heal(amount: int) -> void:
	var old := _current_health
	_current_health = clampi(_current_health + amount, 0, max_health)
	health_changed.emit(old, _current_health)

func get_health() -> int:
	return _current_health
