extends Node

enum State { IDLE, PATROL, CHASE, ATTACK }

var state: State = State.IDLE

func _process(_delta: float) -> void:
	match state:
		State.IDLE:
			_idle_state()
		State.PATROL:
			_patrol_state()
		State.CHASE:
			_chase_state()
		State.ATTACK:
			_attack_state()

func transition_to(new_state: State) -> void:
	state = new_state

func _idle_state() -> void:
	print("IDLE")

func _patrol_state() -> void:
	print("PATROL")

func _chase_state() -> void:
	print("CHASE")

func _attack_state() -> void:
	print("ATTACK")
