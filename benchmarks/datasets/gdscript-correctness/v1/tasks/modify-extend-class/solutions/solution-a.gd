class_name RangedEnemy
extends BaseEnemy

var _attack_cooldown_timer: float = 0.0

func _physics_process(delta: float) -> void:
	super(delta)
	_attack_cooldown_timer -= delta
	if target and global_position.distance_to(target.global_position) < attack_range:
		if _attack_cooldown_timer <= 0.0:
			_fire_projectile()
			_attack_cooldown_timer = attack_cooldown

func _fire_projectile() -> void:
	print("FIRE")
