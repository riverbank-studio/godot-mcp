class_name BaseEnemy
extends CharacterBody2D

@export var speed: float = 100.0
@export var attack_range: float = 300.0
@export var attack_cooldown: float = 2.0

var target: Node2D

func _physics_process(delta: float) -> void:
	if target:
		var direction := (target.global_position - global_position).normalized()
		velocity = direction * speed
		move_and_slide()
