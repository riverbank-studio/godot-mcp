extends CharacterBody2D

@export var waypoints: Array[Vector2] = []
@export var speed: float = 100.0

var _current_waypoint: int = 0

@onready var _nav_agent: NavigationAgent2D = $NavigationAgent2D

func _ready() -> void:
	if waypoints.size() > 0:
		_nav_agent.target_position = waypoints[_current_waypoint]

func _physics_process(_delta: float) -> void:
	if waypoints.is_empty():
		return

	if _nav_agent.is_navigation_finished():
		_current_waypoint = (_current_waypoint + 1) % waypoints.size()
		_nav_agent.target_position = waypoints[_current_waypoint]
		return

	var next_pos := _nav_agent.get_next_path_position()
	var direction := (next_pos - global_position).normalized()
	velocity = direction * speed
	move_and_slide()
