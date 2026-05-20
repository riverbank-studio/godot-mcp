extends Node2D

func play_death_and_free() -> void:
	$AnimationPlayer.play("death")
	yield($AnimationPlayer, "animation_finished")
	queue_free()
