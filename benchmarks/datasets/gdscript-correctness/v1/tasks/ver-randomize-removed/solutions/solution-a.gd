extends Node

var _rng := RandomNumberGenerator.new()

func _ready() -> void:
	_rng.seed = 12345  # reproducible sequence; omit for random

func roll_dice() -> int:
	return _rng.randi_range(1, 6)
