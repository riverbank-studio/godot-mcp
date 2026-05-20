extends CharacterBody2D

@export_group("Movement")
@export var speed: float = 150.0
@export var acceleration: float = 600.0
@export var deceleration: float = 400.0

@export_group("Combat")
@export var attack_damage: int = 25
@export var attack_range: float = 80.0
@export var attack_cooldown: float = 1.5

func _physics_process(delta: float) -> void:
	pass
