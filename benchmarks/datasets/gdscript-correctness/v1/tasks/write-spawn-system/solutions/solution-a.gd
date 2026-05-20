extends Node2D

@export var enemy_scene: PackedScene
@export var max_enemies: int = 10
@export var spawn_interval: float = 3.0

func _ready() -> void:
	var timer := Timer.new()
	timer.wait_time = spawn_interval
	timer.one_shot = false
	timer.timeout.connect(_spawn_enemy)
	add_child(timer)
	timer.start()

func _spawn_enemy() -> void:
	if get_tree().get_nodes_in_group("enemy").size() >= max_enemies:
		return
	if not enemy_scene:
		return
	var enemy := enemy_scene.instantiate()
	add_child(enemy)
	enemy.position = Vector2(randf_range(-200.0, 200.0), randf_range(-200.0, 200.0))
